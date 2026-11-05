// @vitest-environment node
// Calendar links over HTTP: the signed-in routes (make, list, withdraw) and the two public ones
// (open with the password, read the events), through an h3 router with the real route files, an
// in-memory database, a stand-in for token verification and a fake Radicale reader.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import linksDelete from '../../server/api/calendar-links/[id].delete'
import linksGet from '../../server/api/calendar-links/index.get'
import linksPost from '../../server/api/calendar-links/index.post'
import eventsGet from '../../server/api/link/[slug]/events.get'
import sessionPost from '../../server/api/link/[slug]/session.post'
import { upsertUser } from '../../server/db/users'
import apiGuards from '../../server/middleware/api-guards'
import { createAdminLimiter } from '../../server/utils/api/admin-limit'
import { setDb } from '../../server/utils/db'
import * as password from '../../server/utils/links/password'
import { resetLinkLimits } from '../../server/utils/links/ports'
import type { CalendarProbe, CalendarRead, LinkReader } from '../../server/utils/links/reader'
import { openTestDb } from './api-fixtures'

const SUBS = {
  alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
  bob: '6f9f0e2d-0000-4000-8000-000000000002',
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

let db: Database
let handle: (request: Request) => Promise<Response>
let probe: CalendarProbe
let read: CalendarRead
let reads: { principal: string; path: string }[]

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  upsertUser(db, { sub: SUBS.alice, username: 'alice' })
  upsertUser(db, { sub: SUBS.bob, username: 'bob' })
  probe = { kind: 'ok', name: 'Work', color: '#1d4ed8', isCalendar: true }
  read = { kind: 'ok', objects: [EVENT] }
  reads = []
  fake.verifyCalls = 0
  fake.reader = {
    probe: async () => probe,
    read: async (principal, path) => {
      reads.push({ principal, path })
      return read
    },
  }
  resetLinkLimits()
  const router = createRouter()
  for (const [method, path, handler] of ROUTES) {
    router.add(path, handler, method.toLowerCase() as 'get')
  }
  handle = toWebHandler(createApp().use(apiGuards).use(router))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
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

async function makeLink(body: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/calendar-links', 'alice', {
    calendarHref: HREF,
    password: PASSWORD,
    ...body,
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { slug: string; link: { id: number; label: string } }
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

  it('makes a link to one of the caller’s calendars, shows its address once and keeps only hashes', async () => {
    const { slug, link } = await makeLink({ label: 'For the parents' })
    expect(slug).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(link).toMatchObject({
      label: 'For the parents',
      calendarName: 'Work',
      calendarColor: '#1d4ed8',
    })
    const row = db.prepare('SELECT * FROM calendar_links').get() as Record<string, string>
    expect(JSON.stringify(row)).not.toContain(slug)
    expect(JSON.stringify(row)).not.toContain(PASSWORD)
    expect(row.collection_path).toBe(`/${SUBS.alice}/work/`)
    // checked as alice: she can query the events
    expect(reads).toEqual([{ principal: SUBS.alice, path: `/${SUBS.alice}/work/` }])
    // the list has no secrets
    const list = await (await call('GET', '/api/calendar-links', 'alice')).json()
    expect(JSON.stringify(list)).not.toContain(slug)
    expect(list.links).toHaveLength(1)
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
      password: PASSWORD,
    })
    expect(res.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })

  it('refuses a calendar the caller cannot see, and one they see as busy times only', async () => {
    probe = { kind: 'forbidden' }
    expect(
      (
        await call('POST', '/api/calendar-links', 'alice', {
          calendarHref: HREF,
          password: PASSWORD,
        })
      ).status,
    ).toBe(400)
    probe = { kind: 'ok', name: 'Work', color: null, isCalendar: true }
    read = { kind: 'forbidden' }
    const res = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref: HREF,
      password: PASSWORD,
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('busy times')
  })

  it('refuses a short password and says why', async () => {
    const res = await call('POST', '/api/calendar-links', 'alice', {
      calendarHref: HREF,
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
          password: PASSWORD,
        })
      ).status,
    ).toBe(502)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })
})

describe('withdrawing a link', () => {
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
    const body = (await res.json()) as { token: string; calendar: { name: string } }
    expect(body.calendar).toEqual({ name: 'Work', color: '#1d4ed8' })
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
  async function session() {
    const { slug, link } = await makeLink()
    const { token } = (await (await openLink(slug)).json()) as { token: string }
    return { slug, link, token }
  }

  it('reads as the maker, in the range, and shows only what a link may show', async () => {
    const { slug, token } = await session()
    reads = []
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { objects: { data: string; blocked: boolean }[] }
    expect(body.objects).toHaveLength(1)
    expect(body.objects[0]!.data).toContain('SUMMARY:Planning')
    expect(body.objects[0]!.data).not.toContain('budget')
    expect(body.objects[0]!.data).not.toContain('anna@')
    expect(reads).toEqual([{ principal: SUBS.alice, path: `/${SUBS.alice}/work/` }])
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
    const res = await call('GET', `/api/link/${slug}/events${RANGE}`, null, undefined, {
      'x-calendar-link-session': token,
    })
    expect(res.status).toBe(404)
  })
})

// The password module is used for real (scrypt); its export is only wrapped to count the checks.
void password
