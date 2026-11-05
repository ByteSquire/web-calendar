// Calendar links without HTTP: making one (in Settings as oneself, or on the access page as an
// admin), what its maker and admins see of it, and the two things the public page does with one
// (open it with the password, read its events). The routes in server/api/calendar-links,
// server/api/admin/access and server/api/link are thin frames around these.
//
// A link has the level of an access rule and works like a share at that level: `read` shows what a
// read share shows (the calendar data as Radicale returns it), `free_busy` shows what a free/busy
// share shows (Radicale's busy times, nothing of the events). It reads the calendar as its maker
// (made in Settings: never more than they see, and only while they sign in within the window) or as
// the collection's owner (made by an admin on the access page, like an access rule of the calendar).
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { TokenHashKeys } from '../../db/app-tokens'
import {
  countCalendarLinks,
  countCalendarLinksOfCalendar,
  findCalendarLinkBySlugHash,
  insertCalendarLink,
  touchCalendarLink,
  type CalendarLinkWithMaker,
  type LinkLevel,
} from '../../db/calendar-links'
import type { CalendarRow } from '../../db/types'
import { ApiError, conflict, toBadRequest, upstreamFailed } from '../api/errors'
import { FieldErrors, finish, readObject, readText, type Parsed } from '../api/validation'
import { signinCutoff } from '../auth/window'
import { PathRejection, resolvePublicPath } from '../gateway/paths'
import { sharedCalendarId } from '../sharing/names'
import { passwordProblem, verifyPassword } from './password'
import type { LinkReader } from './reader'
import { openLinkSecret, sealLinkSecret } from './secret'
import { createLinkSession, readLinkSession, type LinkSession } from './session'

export const MAX_LINKS_PER_USER = 50
export const MAX_LINKS_PER_CALENDAR = 50
export const MAX_LABEL_LENGTH = 100
const MAX_HREF_LENGTH = 600
/** The longest span one read may ask for: a year view with the days around it. */
export const MAX_RANGE_DAYS = 400
const DAY_MS = 24 * 60 * 60 * 1000
export const LINK_LEVELS: readonly LinkLevel[] = ['free_busy', 'read']

export interface LinkInput {
  label?: string
  level: LinkLevel
  password: string
}

function readLinkFields(object: Record<string, unknown>, errors: FieldErrors): Partial<LinkInput> {
  let label: string | undefined
  if (object.label !== undefined && object.label !== null && object.label !== '') {
    label = readText(object.label, 'label', MAX_LABEL_LENGTH, errors)
  }
  const level = object.level
  if (level !== 'read' && level !== 'free_busy') errors.add('level', 'must be read or free_busy')
  const problem = passwordProblem(object.password)
  if (problem) errors.add('password', problem)
  return {
    ...(label !== undefined ? { label } : {}),
    level: level as LinkLevel,
    password: object.password as string,
  }
}

/** `{ calendarHref, level, label?, password }`: a link made in Settings. */
export function parseLinkCreate(body: unknown): Parsed<LinkInput & { calendarHref: string }> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const calendarHref = readText(object.calendarHref, 'calendarHref', MAX_HREF_LENGTH, errors)
  const fields = readLinkFields(object, errors)
  return finish(errors, () => ({ ...(fields as LinkInput), calendarHref: calendarHref! }))
}

/** `{ level, label?, password }`: a link an admin makes on the access page. */
export function parseAdminLinkCreate(body: unknown): Parsed<LinkInput> {
  const errors = new FieldErrors()
  const fields = readLinkFields(readObject(body, errors), errors)
  return finish(errors, () => fields as LinkInput)
}

/**
 * The store path of a calendar in the caller's own home, from the address the app uses for it
 * (`/caldav/<sub>/<calendar>/`), decoded. Null for anything else: another person's home, a path that
 * is not one calendar, or one the gateway would refuse. Shared and group calendars are in the
 * member's own home too (Radicale maps them there).
 */
export function ownCalendarPath(href: string, sub: string): string | null {
  let upstream: string
  try {
    upstream = resolvePublicPath(href, { allowQuery: false }).upstreamPath
  } catch (error) {
    if (error instanceof PathRejection) return null
    throw error
  }
  const segments = upstream.split('/').slice(1)
  if (segments.length !== 3 || segments[2] !== '') return null
  const [home, calendar] = segments.map((segment) => decodeURIComponent(segment))
  if (home !== sub || !calendar) return null
  return `/${home}/${calendar}/`
}

/**
 * The calendar of the access page a path in a person's home is: a share is named after the
 * calendar's id (`shared-<id>[-group]`), an own calendar is found by its collection path.
 */
export function calendarIdOfPath(db: Database, path: string): number | null {
  const name = path.split('/')[2] ?? ''
  const shared = sharedCalendarId(name)
  const id =
    shared ??
    (
      db
        .prepare<[string], { id: number }>('SELECT id FROM calendars WHERE collection_path = ?')
        .get(path) ?? null
    )?.id ??
    null
  if (id === null) return null
  return db.prepare('SELECT 1 FROM calendars WHERE id = ?').get(id) ? id : null
}

/** The principal that owns a collection: the first segment of its path. */
export const ownerOfPath = (path: string): string => path.split('/')[1] ?? ''

export const slugHashOf = (slug: string): string =>
  createHash('sha256').update(slug, 'utf8').digest('hex')

const SLUG = /^[A-Za-z0-9_-]{43}$/

export interface CreateContext {
  db: Database
  reader: LinkReader
  keyring: TokenHashKeys
  userId: number
  hashPassword(password: string): Promise<string>
  audit(action: string, target?: string, details?: Record<string, unknown>): void
  atomic<T>(work: () => T): T
  now?: Date
}

const fieldError = (field: string, message: string) => toBadRequest([{ field, message }])
const UPSTREAM = 'The calendar server did not answer. Try again.'

/**
 * Whether `principal` gets what the level shows of the calendar, asked of Radicale: a calendar
 * query for `read`, a free/busy query for `free_busy`. A free/busy share answers the second only.
 */
async function checkLevel(
  ctx: CreateContext,
  principal: string,
  path: string,
  level: LinkLevel,
): Promise<'ok' | 'denied'> {
  const now = ctx.now ?? new Date()
  const until = new Date(now.getTime() + DAY_MS)
  const answer =
    level === 'read'
      ? await ctx.reader.read(principal, path, now, until)
      : await ctx.reader.freeBusy(principal, path, now, until)
  if (answer.kind === 'error') throw upstreamFailed(UPSTREAM)
  return answer.kind === 'ok' ? 'ok' : 'denied'
}

async function insertLink(
  ctx: CreateContext,
  fields: {
    path: string
    calendarId: number | null
    readsAs: 'maker' | 'owner'
    name: string
    color: string | null
  },
  input: LinkInput,
): Promise<{ link: CalendarLinkWithMaker; slug: string }> {
  const slug = randomBytes(32).toString('base64url')
  const slugHash = slugHashOf(slug)
  const passwordHash = await ctx.hashPassword(input.password)
  const name = (fields.name || fields.path.split('/')[2] || 'Calendar').slice(0, 200)
  const link = ctx.atomic(() => {
    const created = insertCalendarLink(ctx.db, {
      userId: ctx.userId,
      collectionPath: fields.path,
      calendarName: name,
      calendarColor: fields.color,
      label: input.label ?? name.slice(0, MAX_LABEL_LENGTH),
      slugHash,
      passwordHash,
      level: input.level,
      readsAs: fields.readsAs,
      calendarId: fields.calendarId,
      secretSealed: sealLinkSecret(ctx.keyring, slugHash, { slug, password: input.password }),
    })
    ctx.audit('calendar_link.created', `calendar_link:${created.id}`, {
      linkId: created.id,
      calendar: created.collection_path,
      calendarId: created.calendar_id,
      level: created.level,
      readsAs: created.reads_as,
      label: created.label,
    })
    return created
  })
  return { link, slug }
}

/**
 * A link made in Settings, to a calendar the caller can view at the chosen level: Radicale must
 * answer the level's query as the caller. A person with a free/busy share can make a free/busy link
 * only, so a link never shows more than its maker sees.
 */
export async function createCalendarLink(
  ctx: CreateContext & { sub: string },
  input: LinkInput & { calendarHref: string },
): Promise<{ link: CalendarLinkWithMaker; slug: string }> {
  const path = ownCalendarPath(input.calendarHref, ctx.sub)
  if (!path) throw fieldError('calendarHref', 'must be one of your calendars')
  if (countCalendarLinks(ctx.db, ctx.userId) >= MAX_LINKS_PER_USER) {
    throw conflict('limit_reached', `You can have at most ${MAX_LINKS_PER_USER} calendar links`)
  }
  const probe = await ctx.reader.probe(ctx.sub, path)
  if (probe.kind === 'error') throw upstreamFailed(UPSTREAM)
  if (probe.kind !== 'ok' || !probe.isCalendar) {
    throw fieldError('calendarHref', 'must be one of your calendars')
  }
  if ((await checkLevel(ctx, ctx.sub, path, input.level)) === 'denied') {
    throw fieldError(
      'level',
      'is more than you can see of this calendar; you see its busy times only',
    )
  }
  return insertLink(
    ctx,
    {
      path,
      calendarId: calendarIdOfPath(ctx.db, path),
      readsAs: 'maker',
      name: probe.name,
      color: probe.color,
    },
    input,
  )
}

/**
 * A link an admin makes on the access page: it belongs to the calendar, like an access rule, and
 * reads it as the principal that owns the collection, so it shows the calendar at its level
 * whoever made it, until it is removed or the calendar is deleted.
 */
export async function createAdminCalendarLink(
  ctx: CreateContext,
  calendar: Pick<CalendarRow, 'id' | 'name' | 'color' | 'collection_path'>,
  input: LinkInput,
): Promise<{ link: CalendarLinkWithMaker; slug: string }> {
  if (countCalendarLinksOfCalendar(ctx.db, calendar.id) >= MAX_LINKS_PER_CALENDAR) {
    throw conflict('limit_reached', `A calendar has at most ${MAX_LINKS_PER_CALENDAR} links`)
  }
  const path = calendar.collection_path
  if ((await checkLevel(ctx, ownerOfPath(path), path, input.level)) === 'denied') {
    throw new ApiError(409, 'The calendar server does not have this calendar any more', {
      code: 'no_collection',
    })
  }
  return insertLink(
    ctx,
    { path, calendarId: calendar.id, readsAs: 'owner', name: calendar.name, color: calendar.color },
    input,
  )
}

/** A link as its maker and admins see it in a list: the address when it can be shown, no password. */
export function linkView(keyring: TokenHashKeys, link: CalendarLinkWithMaker) {
  const secret = openLinkSecret(keyring, link.slug_hash, link.secret_sealed)
  return {
    id: link.id,
    label: link.label,
    calendarName: link.calendar_name,
    calendarColor: link.calendar_color,
    calendarId: link.calendar_id,
    level: link.level,
    readsAs: link.reads_as,
    maker: link.maker_name || link.maker_username || 'Unknown person',
    createdAt: link.created_at,
    lastUsedAt: link.last_used_at,
    /** The random part of the address; null when it cannot be shown (an old link, a dropped key). */
    slug: secret?.slug ?? null,
  }
}

/** The password of a link for showing it; null when it cannot be shown. The caller audits. */
export function linkPassword(keyring: TokenHashKeys, link: CalendarLinkWithMaker): string | null {
  return openLinkSecret(keyring, link.slug_hash, link.secret_sealed)?.password ?? null
}

// ---- The public side ----------------------------------------------------------------------------

/** What a visitor is told: the link does not exist, was removed or does not work at the moment. */
export class LinkUnavailableError extends Error {
  constructor() {
    super('This link does not exist, was withdrawn or does not work at the moment')
    this.name = 'LinkUnavailableError'
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('The password is not right')
    this.name = 'WrongPasswordError'
  }
}

export class SessionError extends Error {
  constructor() {
    super('Enter the password again')
    this.name = 'SessionError'
  }
}

export interface PublicContext {
  db: Database
  keyring: TokenHashKeys
  /** NUXT_SIGNIN_WINDOW_DAYS in ms: a link made in Settings works while its maker signs in. */
  windowMs: number
  now?: Date
}

/** The principal a link reads as. */
const readerOf = (link: CalendarLinkWithMaker): string =>
  link.reads_as === 'owner' ? ownerOfPath(link.collection_path) : link.maker_sub

/**
 * The link of a slug, if it may be used now. A link made in Settings acts as its maker, so it
 * follows the rule of app tokens: it works while the maker has signed in within the window (the
 * identity provider never tells Radicale that a person left). A link of the access page belongs to
 * the calendar and has no such limit.
 */
function usableLink(ctx: PublicContext, slug: string): CalendarLinkWithMaker {
  if (!SLUG.test(slug)) throw new LinkUnavailableError()
  const link = findCalendarLinkBySlugHash(ctx.db, slugHashOf(slug))
  if (!link) throw new LinkUnavailableError()
  if (link.reads_as === 'maker') {
    const cutoff = signinCutoff(ctx.windowMs, ctx.now ?? new Date())
    if (!link.maker_last_seen_at || link.maker_last_seen_at < cutoff) {
      throw new LinkUnavailableError()
    }
  }
  return link
}

export interface OpenedLink extends LinkSession {
  calendar: { name: string; color: string | null }
  level: LinkLevel
}

/** The password of the link was right: a session for its page. The caller throttles first. */
export async function openCalendarLink(
  ctx: PublicContext,
  slug: string,
  password: string,
): Promise<{ linkId: number; opened: OpenedLink }> {
  const link = usableLink(ctx, slug)
  if (!(await verifyPassword(password, link.password_hash))) throw new WrongPasswordError()
  const now = ctx.now ?? new Date()
  touchCalendarLink(ctx.db, link, now)
  return {
    linkId: link.id,
    opened: {
      ...createLinkSession(ctx.keyring, link.id, now),
      calendar: { name: link.calendar_name, color: link.calendar_color },
      level: link.level,
    },
  }
}

/** `from` and `to` of a read: ISO date-times, `to` after `from`, at most MAX_RANGE_DAYS apart. */
export function parseRange(
  from: unknown,
  to: unknown,
): { ok: true; start: Date; end: Date } | { ok: false } {
  if (typeof from !== 'string' || typeof to !== 'string') return { ok: false }
  if (from.length > 40 || to.length > 40) return { ok: false }
  const start = new Date(from)
  const end = new Date(to)
  const startMs = start.getTime()
  const endMs = end.getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { ok: false }
  if (endMs - startMs > MAX_RANGE_DAYS * DAY_MS) return { ok: false }
  if (start.getUTCFullYear() < 1900 || end.getUTCFullYear() > 9999) return { ok: false }
  return { ok: true, start, end }
}

/** Reads of the links of one principal that may run at once; they bypass the gateway's own cap. */
export const MAX_READS_PER_MAKER = 2
const readsRunning = new Map<string, number>()

export class ReadsBusyError extends Error {
  constructor() {
    super('This calendar is being read already; try again in a moment')
    this.name = 'ReadsBusyError'
  }
}

export type LinkRead =
  { level: 'read'; objects: string[] } | { level: 'free_busy'; freeBusy: string }

/**
 * What the link shows in the range, read as its principal. `read`: the calendar objects as Radicale
 * returns them, as a read share gets them. `free_busy`: Radicale's busy times, and no other request
 * is made, so not even a principal that could read more gets the events. A session of another
 * link, an expired one or one of a removed link is refused; at most MAX_READS_PER_MAKER reads of
 * one principal's links run at once.
 */
export async function readCalendarLink(
  ctx: PublicContext & { reader: LinkReader },
  slug: string,
  token: string | null | undefined,
  range: { start: Date; end: Date },
): Promise<LinkRead> {
  const link = usableLink(ctx, slug)
  const linkId = readLinkSession(ctx.keyring, token, ctx.now ?? new Date())
  if (linkId === null || linkId !== link.id) throw new SessionError()
  const principal = readerOf(link)
  const running = readsRunning.get(principal) ?? 0
  if (running >= MAX_READS_PER_MAKER) throw new ReadsBusyError()
  readsRunning.set(principal, running + 1)
  try {
    if (link.level === 'free_busy') {
      const busy = await ctx.reader.freeBusy(
        principal,
        link.collection_path,
        range.start,
        range.end,
      )
      if (busy.kind === 'error') throw new ApiError(502, UPSTREAM)
      if (busy.kind !== 'ok') throw new LinkUnavailableError()
      return { level: 'free_busy', freeBusy: busy.text }
    }
    const read = await ctx.reader.read(principal, link.collection_path, range.start, range.end)
    if (read.kind === 'error') throw new ApiError(502, UPSTREAM)
    // The principal cannot read the calendar any more (the share ended, the calendar is gone).
    if (read.kind !== 'ok') throw new LinkUnavailableError()
    return { level: 'read', objects: read.objects }
  } finally {
    const left = (readsRunning.get(principal) ?? 1) - 1
    if (left > 0) readsRunning.set(principal, left)
    else readsRunning.delete(principal)
  }
}
