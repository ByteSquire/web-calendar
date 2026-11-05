// Calendar links without HTTP: making one (who may, for which calendar), and the two things the
// public page does with one (open it with the password, read its events). The routes in
// server/api/calendar-links and server/api/link are thin frames around these.
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  countCalendarLinks,
  findCalendarLinkBySlugHash,
  insertCalendarLink,
  touchCalendarLink,
  type CalendarLinkForRead,
  type CalendarLinkSummary,
} from '../../db/calendar-links'
import type { TokenHashKeys } from '../../db/app-tokens'
import { ApiError, conflict, toBadRequest, upstreamFailed } from '../api/errors'
import { FieldErrors, finish, readObject, readText, type Parsed } from '../api/validation'
import { signinCutoff } from '../auth/window'
import { PathRejection, resolvePublicPath } from '../gateway/paths'
import { passwordProblem, verifyPassword } from './password'
import type { LinkReader } from './reader'
import { sanitizeCalendarObject, type SanitizedObject } from './sanitize'
import { createLinkSession, readLinkSession, type LinkSession } from './session'

export const MAX_LINKS_PER_USER = 50
export const MAX_LABEL_LENGTH = 100
const MAX_HREF_LENGTH = 600
/** The longest span one read may ask for: a year view with the days around it. */
export const MAX_RANGE_DAYS = 400
const DAY_MS = 24 * 60 * 60 * 1000

export interface LinkCreateInput {
  calendarHref: string
  label?: string
  password: string
}

/** `{ calendarHref, label?, password }`; the password is checked for its length only. */
export function parseLinkCreate(body: unknown): Parsed<LinkCreateInput> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const calendarHref = readText(object.calendarHref, 'calendarHref', MAX_HREF_LENGTH, errors)
  let label: string | undefined
  if (object.label !== undefined && object.label !== null && object.label !== '') {
    label = readText(object.label, 'label', MAX_LABEL_LENGTH, errors)
  }
  const problem = passwordProblem(object.password)
  if (problem) errors.add('password', problem)
  return finish(errors, () => ({
    calendarHref: calendarHref!,
    ...(label !== undefined ? { label } : {}),
    password: object.password as string,
  }))
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

export const slugHashOf = (slug: string): string =>
  createHash('sha256').update(slug, 'utf8').digest('hex')

const SLUG = /^[A-Za-z0-9_-]{43}$/

export interface CreatedLink {
  link: CalendarLinkSummary
  /** The random part of the address; shown once, only its hash is kept. */
  slug: string
}

export interface CreateContext {
  db: Database
  reader: LinkReader
  sub: string
  userId: number
  hashPassword(password: string): Promise<string>
  audit(action: string, target?: string, details?: Record<string, unknown>): void
  atomic<T>(work: () => T): T
  now?: Date
}

const fieldError = (field: string, message: string) => toBadRequest([{ field, message }])

/**
 * Makes a link to a calendar the caller can view. "Can view" is what Radicale says: the calendar
 * answers a query for its events as the caller. A calendar the caller sees as busy times only
 * (a free/busy share) cannot be linked, because the link would show more than they see.
 */
export async function createCalendarLink(
  ctx: CreateContext,
  input: LinkCreateInput,
): Promise<CreatedLink> {
  const path = ownCalendarPath(input.calendarHref, ctx.sub)
  if (!path) throw fieldError('calendarHref', 'must be one of your calendars')
  if (countCalendarLinks(ctx.db, ctx.userId) >= MAX_LINKS_PER_USER) {
    throw conflict('limit_reached', `You can have at most ${MAX_LINKS_PER_USER} calendar links`)
  }
  const probe = await ctx.reader.probe(ctx.sub, path)
  if (probe.kind === 'error') throw upstreamFailed('The calendar server did not answer. Try again.')
  if (probe.kind !== 'ok' || !probe.isCalendar) {
    throw fieldError('calendarHref', 'must be one of your calendars')
  }
  const now = ctx.now ?? new Date()
  const read = await ctx.reader.read(ctx.sub, path, now, new Date(now.getTime() + DAY_MS))
  if (read.kind === 'error') throw upstreamFailed('The calendar server did not answer. Try again.')
  if (read.kind !== 'ok') {
    throw fieldError(
      'calendarHref',
      'is a calendar you can only see as busy times, so it cannot be shared with a link',
    )
  }
  const slug = randomBytes(32).toString('base64url')
  const passwordHash = await ctx.hashPassword(input.password)
  const calendarName = (probe.name || path.split('/')[2] || 'Calendar').slice(0, 200)
  const link = ctx.atomic(() => {
    const created = insertCalendarLink(ctx.db, {
      userId: ctx.userId,
      collectionPath: path,
      calendarName,
      calendarColor: probe.color,
      label: input.label ?? calendarName.slice(0, MAX_LABEL_LENGTH),
      slugHash: slugHashOf(slug),
      passwordHash,
    })
    ctx.audit('calendar_link.created', `calendar_link:${created.id}`, {
      linkId: created.id,
      calendar: created.collectionPath,
      label: created.label,
    })
    return created
  })
  return { link, slug }
}

// ---- The public side ----------------------------------------------------------------------------

/** What a visitor is told: the link does not exist, was withdrawn or does not work right now. */
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
  /** NUXT_SIGNIN_WINDOW_DAYS in ms: a link works while its maker has signed in within it. */
  windowMs: number
  now?: Date
}

/**
 * The link of a slug, if it may be used now. A link acts as its maker, so it follows the rule of
 * app tokens: it works while the maker has signed in within the window (the identity provider
 * never tells Radicale that a person left).
 */
function usableLink(ctx: PublicContext, slug: string): CalendarLinkForRead {
  if (!SLUG.test(slug)) throw new LinkUnavailableError()
  const link = findCalendarLinkBySlugHash(ctx.db, slugHashOf(slug))
  if (!link) throw new LinkUnavailableError()
  const cutoff = signinCutoff(ctx.windowMs, ctx.now ?? new Date())
  if (!link.owner_last_seen_at || link.owner_last_seen_at < cutoff) throw new LinkUnavailableError()
  return link
}

export interface OpenedLink extends LinkSession {
  calendar: { name: string; color: string | null }
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

/** Reads of one maker's links that may run at once; they bypass the gateway's own cap. */
export const MAX_READS_PER_MAKER = 2
const readsRunning = new Map<string, number>()

export class ReadsBusyError extends Error {
  constructor() {
    super('This calendar is being read already; try again in a moment')
    this.name = 'ReadsBusyError'
  }
}

/**
 * The events of the link in the range, as the maker sees them and cut down to what a link shows.
 * A session of another link, an expired one or one of a withdrawn link is refused. At most
 * MAX_READS_PER_MAKER reads of one maker's links run at once (Radicale is asked as the maker, and an
 * expanded year is work for it); one more is refused (`ReadsBusyError`) instead of queueing.
 */
export async function readCalendarLink(
  ctx: PublicContext & { reader: LinkReader },
  slug: string,
  token: string | null | undefined,
  range: { start: Date; end: Date },
): Promise<{ objects: SanitizedObject[] }> {
  const link = usableLink(ctx, slug)
  const linkId = readLinkSession(ctx.keyring, token, ctx.now ?? new Date())
  if (linkId === null || linkId !== link.id) throw new SessionError()
  const running = readsRunning.get(link.owner_sub) ?? 0
  if (running >= MAX_READS_PER_MAKER) throw new ReadsBusyError()
  readsRunning.set(link.owner_sub, running + 1)
  let read: Awaited<ReturnType<LinkReader['read']>>
  try {
    read = await ctx.reader.read(link.owner_sub, link.collection_path, range.start, range.end)
  } finally {
    const left = (readsRunning.get(link.owner_sub) ?? 1) - 1
    if (left > 0) readsRunning.set(link.owner_sub, left)
    else readsRunning.delete(link.owner_sub)
  }
  if (read.kind === 'error')
    throw new ApiError(502, 'The calendar server did not answer. Try again.')
  // The maker cannot read the calendar any more (the share ended, the calendar is gone).
  if (read.kind !== 'ok') throw new LinkUnavailableError()
  const objects: SanitizedObject[] = []
  for (const object of read.objects) {
    const clean = sanitizeCalendarObject(object)
    if (clean) objects.push(clean)
  }
  return { objects }
}
