// @vitest-environment node
// Calendar links over HTTP: the signed-in routes (make, list, show the password, remove), the ones
// of the access page (admins) and the two public ones (open with the password, read the events),
// through an h3 router with the real route files, an in-memory database, a stand-in for token
// verification and for userinfo (the admin check), and a fake Radicale reader.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import adminLinksGet from '../../server/api/admin/access/calendars/[id]/links.get'
import adminLinksPost from '../../server/api/admin/access/calendars/[id]/links.post'
import adminLinkDelete from '../../server/api/admin/access/links/[id].delete'
import adminLinkReveal from '../../server/api/admin/access/links/[id]/reveal.post'
import linksDelete from '../../server/api/calendar-links/[id].delete'
import linkReveal from '../../server/api/calendar-links/[id]/reveal.post'
import linksGet from '../../server/api/calendar-links/index.get'
import linksPost from '../../server/api/calendar-links/index.post'
import eventsGet from '../../server/api/link/[slug]/events.get'
import sessionPost from '../../server/api/link/[slug]/session.post'
import { upsertUser } from '../../server/db/users'
import apiGuards from '../../server/middleware/api-guards'
import { createAdminLimiter } from '../../server/utils/api/admin-limit'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { setDb } from '../../server/utils/db'
import * as password from '../../server/utils/links/password'
import { resetLinkLimits } from '../../server/utils/links/ports'
import type {
  CalendarFreeBusy,
  CalendarProbe,
  CalendarRead,
  LinkReader,
} from '../../server/utils/links/reader'
import { openTestDb, seedUserinfoEndpoint } from './api-fixtures'

const SUBS = {
  alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
  bob: '6f9f0e2d-0000-4000-8000-000000000002',
  admin: '7a0b1c2d-0000-4000-8000-000000000003',
} as const
type Who = keyof typeof SUBS

const fake = vi.hoisted(() => ({
  reader: null as unknown as LinkReader,
  verifyCalls: 0,
}))

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  const subs: Record<string, string> = {
    alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
    bob: '6f9f0e2d-0000-4000-8000-000000000002',
    admin: '7a0b1c2d-0000-4000-8000-000000000003',
  }
  return {
    requireUser: async (event: H3Event) => {
      const match = /^Bearer test-(\w+)$/.exec(event.headers.get('authorization') ?? '')
      const sub = match ? subs[match[1]!] : undefined
      if (!sub) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
      return { sub, via: 'bearer' as const }
    },
  }
})

vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    tokenHashKey: 'test-hash-key',
    oidcIssuer: 'https://idm.test/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
    groupsIgnore: [],
    signinWindowMs: 30 * 24 * 60 * 60 * 1000,
  }),
}))

// The per-actor limit of the signed-in routes has its own tests (admin-guard.test.ts).
vi.mock('../../server/utils/api/admin-handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/api/admin-handler')>()
  return { ...actual, checkRateLimit: () => undefined }
})

vi.mock('../../server/utils/links/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/links/ports')>()
  return {
    ...actual,
    getLinkReader: () => fake.reader,
    linkClientKey: () => '203.0.113.7',
  }
})

vi.mock('../../server/utils/links/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/links/password')>()
  return {
    ...actual,
    verifyPassword: (given: string, stored: string) => {
      fake.verifyCalls += 1
      return actual.verifyPassword(given, stored)
    },
  }
})

const ROUTES: [method: string, path: string, handler: EventHandler][] = [
  ['GET', '/api/calendar-links', linksGet],
  ['POST', '/api/calendar-links', linksPost],
  ['DELETE', '/api/calendar-links/:id', linksDelete],
  ['POST', '/api/calendar-links/:id/reveal', linkReveal],
  ['GET', '/api/admin/access/calendars/:id/links', adminLinksGet],
  ['POST', '/api/admin/access/calendars/:id/links', adminLinksPost],
  ['DELETE', '/api/admin/access/links/:id', adminLinkDelete],
  ['POST', '/api/admin/access/links/:id/reveal', adminLinkReveal],
  ['POST', '/api/link/:slug/session', sessionPost],
  ['GET', '/api/link/:slug/events', eventsGet],
]

const EVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:one@example.org',
  'DTSTAMP:20261101T080000Z',
  'DTSTART:20261110T090000Z',
  'DTEND:20261110T100000Z',
  'SUMMARY:Planning',
  'DESCRIPTION:The budget numbers',
  'ATTENDEE:mailto:anna@example.org',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const FREE_BUSY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VFREEBUSY',
  'FREEBUSY;FBTYPE=BUSY:20261110T090000Z/20261110T100000Z',
  'END:VFREEBUSY',
  'END:VCALENDAR',
].join('\r\n')

let db: Database
let handle: (request: Request) => Promise<Response>
let probe: CalendarProbe
let read: CalendarRead
let freeBusy: CalendarFreeBusy
let reads: { principal: string; path: string }[]
let freeBusyReads: { principal: string; path: string }[]

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  upsertUser(db, { sub: SUBS.alice, username: 'alice' })
  upsertUser(db, { sub: SUBS.bob, username: 'bob', name: 'Bob Builder' })
  upsertUser(db, { sub: SUBS.admin, username: 'admin', name: 'Ada Admin' })
  probe = { kind: 'ok', name: 'Work', color: '#1d4ed8', isCalendar: true }
  read = { kind: 'ok', objects: [EVENT] }
  freeBusy = { kind: 'ok', text: FREE_BUSY }
  reads = []
  freeBusyReads = []
  fake.verifyCalls = 0
  fake.reader = {
    probe: async () => probe,
    read: async (principal, path) => {
      reads.push({ principal, path })
      return read
    },
    freeBusy: async (principal, path) => {
      freeBusyReads.push({ principal, path })
      return freeBusy
    },
  }
  // userinfo for the admin check: only "admin" is in the admin group.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      void input
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      const who = /^Bearer test-(\w+)$/.exec(auth)?.[1] as Who | undefined
      const sub = who ? SUBS[who] : 'nobody'
      return new Response(
        JSON.stringify({ sub, groups: who === 'admin' ? ['calendar_admins'] : [] }),
      )
    }),
  )
  getUserinfoClient().clear()
  seedUserinfoEndpoint()
  resetLinkLimits()
  const router = createRouter()
  for (const [method, path, handler] of ROUTES) {
    router.add(path, handler, method.toLowerCase() as 'get')
  }
  handle = toWebHandler(createApp().use(apiGuards).use(router))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetLinkLimits()
  db.close()
})

function call(
  method: string,
  path: string,
  who: Who | null,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const all: Record<string, string> = { 'content-type': 'application/json', ...headers }
  if (who) all.authorization = `Bearer test-${who}`
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: all,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const HREF = `/caldav/${SUBS.alice}/work/`
const PASSWORD = 'correct horse'

interface LinkView {
  id: number
  label: string
  calendarId: number | null
  level: 'read' | 'free_busy'
  readsAs: 'maker' | 'owner'
  maker: string
  slug: string | null
}

async function makeLink(body: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/calendar-links', 'alice', {
    calendarHref: HREF,
    level: 'read',
    password: PASSWORD,
    ...body,
  })
  expect(res.status).toBe(201)
  const { link } = (await res.json()) as { link: LinkView }
  return { link, slug: link.slug! }
}

async function openLink(slug: string, given = PASSWORD) {
  return call('POST', `/api/link/${slug}/session`, null, { password: given })
}

const RANGE = '?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z'

describe('making a link', () => {
  it('needs a signed-in person', async () => {
    const res = await call('POST', '/api/calendar-links', null, {
      calendarHref: HREF,
      password: PASSWORD,
    })
    expect(res.status).toBe(401)
  })

  it('makes a link to one of the caller’s calendars, keeps hashes and a sealed copy, and lists its address', async () => {
    const { slug, link } = await makeLink({ label: 'For the parents' })
    expect(slug).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(link).toMatchObject({
      label: 'For the parents',
      calendarName: 'Work',
      calendarColor: '#1d4ed8',
      calendarId: null,
      level: 'read',
      readsAs: 'maker',
      maker: 'alice',
    })
    const row = db.prepare('SELECT * FROM calendar_links').get() as Record<string, string>
    expect(JSON.stringify(row)).not.toContain(slug)
    expect(JSON.stringify(row)).not.toContain(PASSWORD)
    expect(row.secret_sealed).toMatch(/^s1\./)
    expect(row.collection_path).toBe(`/${SUBS.alice}/work/`)
    // checked as alice: she can query the events
    expect(reads).toEqual([{ principal: SUBS.alice, path: `/${SUBS.alice}/work/` }])
    // the list shows the address again, never the password
    const list = await (await call('GET', '/api/calendar-links', 'alice')).json()
    expect(list.links).toHaveLength(1)
    expect(list.links[0].slug).toBe(slug)
    expect(JSON.stringify(list)).not.toContain(PASSWORD)
    const audit = db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'calendar_link.%'")
      .pluck()
      .all()
    expect(audit).toEqual(['calendar_link.created'])
  })

  it('names the link after the calendar when no label is given', async () => {
    const { link } = await makeLink()
    expect(link.label).toBe('Work')
  })

  it.each([
    ['another person’s home', `/caldav/${SUBS.bob}/work/`],
    ['a home', `/caldav/${SUBS.alice}/`],
    ['an event', `/caldav/${SUBS.alice}/work/x.ics`],
    ['a path that leaves', `/caldav/${SUBS.alice}/../${SUBS.bob}/work/`],
  ])('refuses %s', async (_label, calendarHref) => {
    const res = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref,
      level: 'read',
      password: PASSWORD,
    })
    expect(res.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })

  it('refuses a calendar the caller cannot see', async () => {
    probe = { kind: 'forbidden' }
    const res = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref: HREF,
      level: 'free_busy',
      password: PASSWORD,
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('calendarHref')
  })

  it('refuses "Can view" to a person who sees the calendar as busy times only, not "Busy times only"', async () => {
    read = { kind: 'forbidden' }
    const refused = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref: HREF,
      level: 'read',
      password: PASSWORD,
    })
    expect(refused.status).toBe(400)
    const body = JSON.stringify(await refused.json())
    expect(body).toContain('level')
    expect(body).toContain('busy times')
    reads = []
    const { link } = await makeLink({ level: 'free_busy' })
    expect(link.level).toBe('free_busy')
    // checked with a free-busy query only
    expect(reads).toEqual([])
    expect(freeBusyReads).toEqual([{ principal: SUBS.alice, path: `/${SUBS.alice}/work/` }])
  })

  it.each([['write'], [undefined], ['']])('refuses the level %s', async (level) => {
    const res = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref: HREF,
      level,
      password: PASSWORD,
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('level')
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })

  it('refuses a short password and says why', async () => {
    const res = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref: HREF,
      level: 'read',
      password: 'short',
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('at least 8')
  })

  it('answers 502 when Radicale does not answer, and makes nothing', async () => {
    probe = { kind: 'error' }
    expect(
      (
        await call('POST', '/api/calendar-links', 'alice', {
          calendarHref: HREF,
          level: 'read',
          password: PASSWORD,
        })
      ).status,
    ).toBe(502)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })
})

describe('showing the password of a link', () => {
  it('gives its maker the password, and writes each time to the audit log', async () => {
    const { link } = await makeLink()
    const res = await call('POST', `/api/calendar-links/${link.id}/reveal`, 'alice')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ password: PASSWORD })
    const audit = db
      .prepare("SELECT action, actor_sub FROM audit_log WHERE action = 'calendar_link.revealed'")
      .all()
    expect(audit).toEqual([{ action: 'calendar_link.revealed', actor_sub: SUBS.alice }])
  })

  it('answers 404 to another person, also an admin, and to a link that does not exist', async () => {
    const { link } = await makeLink()
    expect((await call('POST', `/api/calendar-links/${link.id}/reveal`, 'bob')).status).toBe(404)
    expect((await call('POST', `/api/calendar-links/${link.id}/reveal`, 'admin')).status).toBe(404)
    expect((await call('POST', '/api/calendar-links/999/reveal', 'alice')).status).toBe(404)
    expect(
      db
        .prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'calendar_link.revealed'")
        .pluck()
        .get(),
    ).toBe(0)
  })

  it('says when the address and password cannot be shown any more, and the link works on', async () => {
    const { slug, link } = await makeLink()
    db.prepare('UPDATE calendar_links SET secret_sealed = NULL').run()
    const res = await call('POST', `/api/calendar-links/${link.id}/reveal`, 'alice')
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('not_available')
    const list = await (await call('GET', '/api/calendar-links', 'alice')).json()
    expect(list.links[0].slug).toBeNull()
    expect((await openLink(slug)).status).toBe(200)
  })
})

describe('removing a link', () => {
  it('works for its maker and stops the link at once, open pages too', async () => {
    const { slug, link } = await makeLink()
    const opened = (await (await openLink(slug)).json()) as { token: string }
    expect((await call('DELETE', `/api/calendar-links/${link.id}`, 'bob')).status).toBe(404)
    expect((await call('DELETE', `/api/calendar-links/${link.id}`, 'alice')).status).toBe(200)
    expect((await openLink(slug)).status).toBe(404)
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': opened.token,
    })
    expect(res.status).toBe(404)
  })

  it('lists only the caller’s own links', async () => {
    await makeLink()
    expect((await (await call('GET', '/api/calendar-links', 'bob')).json()).links).toEqual([])
  })
})

describe('opening a link', () => {
  it('gives a session and the calendar’s name for the right password, and nothing is cached', async () => {
    const { slug } = await makeLink()
    const res = await openLink(slug)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    const body = (await res.json()) as {
      token: string
      calendar: { name: string }
      level: string
    }
    expect(body.calendar).toEqual({ name: 'Work', color: '#1d4ed8' })
    expect(body.level).toBe('read')
    expect(body.token).toMatch(/^cls1\./)
  })

  it('answers 401 for a wrong password and 404 for an address that does not exist', async () => {
    const { slug } = await makeLink()
    const wrong = await openLink(slug, 'wrong password')
    expect(wrong.status).toBe(401)
    expect(JSON.stringify(await wrong.json())).not.toContain(PASSWORD)
    expect((await openLink('A'.repeat(43))).status).toBe(404)
    expect((await openLink('short')).status).toBe(404)
  })

  it('stops working while its maker has not signed in within the window', async () => {
    const { slug } = await makeLink()
    db.prepare('UPDATE users SET last_seen_at = ? WHERE oidc_sub = ?').run(
      '2020-01-01T00:00:00.000Z',
      SUBS.alice,
    )
    expect((await openLink(slug)).status).toBe(404)
  })

  it('counts wrong passwords only: once they are used up, every try is refused before the check', async () => {
    const { slug } = await makeLink()
    resetLinkLimits({
      attemptsPerAddress: createAdminLimiter({ burst: 2, refillPerSec: 0.001 }),
      attemptsPerLink: createAdminLimiter({ burst: 100, refillPerSec: 1 }),
      readsPerAddress: createAdminLimiter({ burst: 100, refillPerSec: 1 }),
    })
    fake.verifyCalls = 0
    expect((await openLink(slug, 'wrong one 1')).status).toBe(401)
    expect((await openLink(slug, 'wrong one 2')).status).toBe(401)
    const limited = await openLink(slug)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    // the third try never reached the costly check
    expect(fake.verifyCalls).toBe(2)
  })

  it('never refuses the right password for how often others opened the link', async () => {
    const { slug } = await makeLink()
    resetLinkLimits({
      attemptsPerAddress: createAdminLimiter({ burst: 3, refillPerSec: 0.001 }),
      attemptsPerLink: createAdminLimiter({ burst: 3, refillPerSec: 0.001 }),
      readsPerAddress: createAdminLimiter({ burst: 100, refillPerSec: 1 }),
    })
    // a family of 12 behind one address (or one proxy) opens it on the same morning
    for (let visitor = 0; visitor < 12; visitor += 1) {
      expect((await openLink(slug)).status, `visitor ${visitor}`).toBe(200)
    }
  })

  it('counts addresses that are no link as failures too', async () => {
    resetLinkLimits({
      attemptsPerAddress: createAdminLimiter({ burst: 2, refillPerSec: 0.001 }),
      attemptsPerLink: createAdminLimiter({ burst: 100, refillPerSec: 1 }),
      readsPerAddress: createAdminLimiter({ burst: 100, refillPerSec: 1 }),
    })
    expect((await openLink('B'.repeat(43))).status).toBe(404)
    expect((await openLink('C'.repeat(43))).status).toBe(404)
    expect((await openLink('D'.repeat(43))).status).toBe(429)
  })

  it('refuses a password that is too long without checking it', async () => {
    const { slug } = await makeLink()
    fake.verifyCalls = 0
    expect((await openLink(slug, 'x'.repeat(201))).status).toBe(400)
    expect(fake.verifyCalls).toBe(0)
  })
})

describe('reading the events of a link', () => {
  async function session(body: Record<string, unknown> = {}) {
    const { slug, link } = await makeLink(body)
    const { token } = (await (await openLink(slug)).json()) as { token: string }
    return { slug, link, token }
  }

  it('at "Can view", reads as the maker, in the range, and passes on what a read share sees', async () => {
    const { slug, token } = await session()
    reads = []
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ level: 'read', objects: [EVENT] })
    expect(reads).toEqual([{ principal: SUBS.alice, path: `/${SUBS.alice}/work/` }])
  })

  it('at "Busy times only", asks Radicale for the busy times only and never reads the events', async () => {
    const { slug, token } = await session({ level: 'free_busy' })
    reads = []
    freeBusyReads = []
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ level: 'free_busy', freeBusy: FREE_BUSY })
    expect(JSON.stringify(body)).not.toContain('Planning')
    expect(reads).toEqual([])
    expect(freeBusyReads).toEqual([{ principal: SUBS.alice, path: `/${SUBS.alice}/work/` }])
  })

  it('needs the session of this very link', async () => {
    const first = await session()
    const second = await makeLink({ label: 'Other' })
    const noSession = await call('GET', `/api/link/${first.slug}/events${RANGE}`, null)
    expect(noSession.status).toBe(401)
    const otherLink = await call(
      'GET',
      `/api/link/${second.slug}/events${RANGE}`,
      null,
      undefined,
      {
        'x-calendar-link-session': first.token,
      },
    )
    expect(otherLink.status).toBe(401)
  })

  it('refuses a range that is not one, or too long', async () => {
    const { slug, token } = await session()
    for (const query of [
      '',
      '?from=x&to=y',
      '?from=2026-01-01T00:00:00Z&to=2027-06-01T00:00:00Z',
    ]) {
      const res = await call('GET', `/api/link/${slug}/events${query}`, null, undefined, {
        'x-calendar-link-session': token,
      })
      expect(res.status, query).toBe(400)
    }
  })

  it('runs at most two reads of one maker’s links at once, and refuses a third at once', async () => {
    const { slug, token } = await session()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    fake.reader = {
      probe: async () => probe,
      read: async () => {
        await held
        return read
      },
      freeBusy: async () => freeBusy,
    }
    const get = () =>
      call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
        'x-calendar-link-session': token,
      })
    const first = get()
    const second = get()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const third = await get()
    expect(third.status).toBe(429)
    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await get()).status).toBe(200)
  })

  it('stops when the maker cannot read the calendar any more (the share ended)', async () => {
    const { slug, token } = await session()
    read = { kind: 'forbidden' }
    freeBusy = { kind: 'forbidden' }
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(res.status).toBe(404)
  })

  it('at "Can view", stops when the maker’s share is lowered to busy times only', async () => {
    const { slug, token } = await session()
    read = { kind: 'forbidden' }
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(res.status).toBe(404)
  })
})

describe('the links of a calendar on the access page', () => {
  let calendarId: number
  const BOB_PATH = `/${SUBS.bob}/calendar/`

  beforeEach(() => {
    const bobId = db.prepare('SELECT id FROM users WHERE oidc_sub = ?').pluck().get(SUBS.bob)
    calendarId = Number(
      db
        .prepare(
          "INSERT INTO calendars (name, kind, owner_id, color, collection_path) VALUES ('Bob’s calendar', 'personal', ?, '#16a34a', ?)",
        )
        .run(bobId, BOB_PATH).lastInsertRowid,
    )
  })

  const adminCreate = (body: Record<string, unknown>, who: Who = 'admin', id = calendarId) =>
    call('POST', `/api/admin/access/calendars/${id}/links`, who, body)

  async function adminLink(level: 'read' | 'free_busy' = 'free_busy') {
    const res = await adminCreate({ level, label: 'Front desk', password: PASSWORD })
    expect(res.status).toBe(201)
    return ((await res.json()) as { link: LinkView }).link
  }

  it('are for admins only, on every route', async () => {
    const link = await adminLink()
    for (const [method, path] of [
      ['GET', `/api/admin/access/calendars/${calendarId}/links`],
      ['POST', `/api/admin/access/calendars/${calendarId}/links`],
      ['DELETE', `/api/admin/access/links/${link.id}`],
      ['POST', `/api/admin/access/links/${link.id}/reveal`],
    ] as const) {
      const body = method === 'POST' ? { level: 'read', password: PASSWORD } : undefined
      const res = await call(method, path, 'alice', body)
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(1)
  })

  it('are made reading as the calendar’s owner, at the level chosen, and open without the sign-in window', async () => {
    const link = await adminLink('free_busy')
    expect(link).toMatchObject({
      label: 'Front desk',
      calendarName: 'Bob’s calendar',
      calendarId,
      level: 'free_busy',
      readsAs: 'owner',
      maker: 'Ada Admin',
    })
    expect(freeBusyReads).toEqual([{ principal: SUBS.bob, path: BOB_PATH }])
    expect(reads).toEqual([])
    // the admin's own sign-in does not matter: the link reads as the owner
    db.prepare('UPDATE users SET last_seen_at = ? WHERE oidc_sub = ?').run(
      '2020-01-01T00:00:00.000Z',
      SUBS.admin,
    )
    const opened = await openLink(link.slug!)
    expect(opened.status).toBe(200)
    const { token } = (await opened.json()) as { token: string }
    freeBusyReads = []
    const res = await call('GET', `/api/link/${link.slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(await res.json()).toEqual({ level: 'free_busy', freeBusy: FREE_BUSY })
    expect(freeBusyReads).toEqual([{ principal: SUBS.bob, path: BOB_PATH }])
    expect(reads).toEqual([])
  })

  it('answers 404 for a calendar that does not exist and 409 when Radicale does not have it', async () => {
    expect((await adminCreate({ level: 'read', password: PASSWORD }, 'admin', 999)).status).toBe(
      404,
    )
    read = { kind: 'no_collection' }
    const res = await adminCreate({ level: 'read', password: PASSWORD })
    expect(res.status).toBe(409)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })

  it('lists the links made here and the ones people made in Settings to the same calendar', async () => {
    await adminLink()
    // alice sees Bob's calendar through a share: it is in her home as shared-<id>
    await makeLink({ calendarHref: `/caldav/${SUBS.alice}/shared-${calendarId}/`, label: 'Mine' })
    await makeLink({ label: 'Elsewhere' })
    const res = await call('GET', `/api/admin/access/calendars/${calendarId}/links`, 'admin')
    expect(res.status).toBe(200)
    const { links } = (await res.json()) as { links: LinkView[] }
    expect(links.map((link) => [link.label, link.readsAs, link.maker]).sort()).toEqual([
      ['Front desk', 'owner', 'Ada Admin'],
      ['Mine', 'maker', 'alice'],
    ])
    expect(links.every((link) => typeof link.slug === 'string')).toBe(true)
    expect(JSON.stringify(links)).not.toContain(PASSWORD)
  })

  it('show their password to an admin, also of a link made in Settings, each time in the audit log', async () => {
    const { link } = await makeLink({
      calendarHref: `/caldav/${SUBS.alice}/shared-${calendarId}/`,
    })
    const res = await call('POST', `/api/admin/access/links/${link.id}/reveal`, 'admin')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ password: PASSWORD })
    const row = db
      .prepare("SELECT actor_sub, details FROM audit_log WHERE action = 'calendar_link.revealed'")
      .get() as { actor_sub: string; details: string }
    expect(row.actor_sub).toBe(SUBS.admin)
    expect(JSON.parse(row.details)).toMatchObject({ linkId: link.id, byAdmin: true })
  })

  it('removed in Settings, are audited with their calendar of the access page and level', async () => {
    const { link } = await makeLink({
      calendarHref: `/caldav/${SUBS.alice}/shared-${calendarId}/`,
      level: 'free_busy',
    })
    expect((await call('DELETE', `/api/calendar-links/${link.id}`, 'alice')).status).toBe(200)
    const details = db
      .prepare("SELECT details FROM audit_log WHERE action = 'calendar_link.deleted'")
      .pluck()
      .get() as string
    expect(JSON.parse(details)).toMatchObject({ linkId: link.id, calendarId, level: 'free_busy' })
  })

  it('are removed by an admin, and the address stops at once; links to no calendar here are not theirs', async () => {
    const link = await adminLink()
    const other = await makeLink()
    expect((await call('DELETE', `/api/admin/access/links/${other.link.id}`, 'admin')).status).toBe(
      404,
    )
    expect(
      (await call('POST', `/api/admin/access/links/${other.link.id}/reveal`, 'admin')).status,
    ).toBe(404)
    expect((await call('DELETE', `/api/admin/access/links/${link.id}`, 'admin')).status).toBe(200)
    expect((await openLink(link.slug!)).status).toBe(404)
    expect((await openLink(other.slug)).status).toBe(200)
    const audit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'calendar_link.deleted'")
      .pluck()
      .get() as string
    expect(JSON.parse(audit)).toMatchObject({ linkId: link.id, calendarId, byAdmin: true })
  })

  it('are at most 50 to a calendar, whoever made them, on both routes', async () => {
    // made by the admin, so no one person's own limit is in the way
    const makerId = db.prepare('SELECT id FROM users WHERE oidc_sub = ?').pluck().get(SUBS.admin)
    const insert = db.prepare(
      `INSERT INTO calendar_links (user_id, collection_path, calendar_name, label, slug_hash,
         password_hash, calendar_id) VALUES (?, ?, 'Bob', ?, ?, 'scrypt$x', ?)`,
    )
    for (let n = 0; n < 50; n += 1) {
      insert.run(
        makerId,
        `/${SUBS.admin}/shared-${calendarId}/`,
        `L${n}`,
        n.toString(16).padStart(64, '0'),
        calendarId,
      )
    }
    const admin = await adminCreate({ level: 'read', password: PASSWORD })
    expect(admin.status).toBe(409)
    expect(JSON.stringify(await admin.json())).toContain('calendar_limit_reached')
    const settings = await call('POST', '/api/calendar-links', 'bob', {
      calendarHref: `/caldav/${SUBS.bob}/shared-${calendarId}/`,
      level: 'read',
      password: PASSWORD,
    })
    expect(settings.status).toBe(409)
    expect(JSON.stringify(await settings.json())).toContain('calendar_limit_reached')
    // a calendar of nobody's access page is not counted
    expect((await makeLink()).link.calendarId).toBeNull()
  })

  it('go when the calendar goes', async () => {
    await adminLink()
    db.prepare('DELETE FROM calendars WHERE id = ?').run(calendarId)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })
})

// The password module is used for real (scrypt); its export is only wrapped to count the checks.
void password
