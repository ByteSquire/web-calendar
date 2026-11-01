// @vitest-environment node
// The access administration API (FR-14): the real routes behind an h3 router, an in-memory
// database, a stand-in for token verification (`Bearer test-<name>` is `sub-<name>`) and for
// fetch (userinfo for the admin check, Kanidm for the group check).
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import calendarsGet from '../../server/api/admin/access/calendars.get'
import calendarsPut from '../../server/api/admin/access/calendars/[id].put'
import usersGet from '../../server/api/admin/access/users.get'
import { listAuditEntries } from '../../server/db/audit-log'
import {
  addCalendarAcl,
  listCalendarAcl,
  markCalendarAclApplied,
} from '../../server/db/calendar-acl'
import { upsertUser } from '../../server/db/users'
import { setAccessPorts } from '../../server/utils/access/ports'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { setDb } from '../../server/utils/db'
import { openTestDb } from './api-fixtures'

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  return {
    requireUser: async (event: H3Event) => {
      const match = /^Bearer test-(\S+)$/.exec(event.headers.get('authorization') ?? '')
      if (!match) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
      return { sub: `sub-${match[1]}`, via: 'bearer' as const }
    },
  }
})

vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    tokenHashKey: 'test-hash-key',
    oidcIssuer: 'https://idm.test/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
  }),
}))

const SYNC_TOKEN = 'kanidm-sync-secret-value'
const settings = vi.hoisted(() => ({ kanidm: null as { origin: string; token: string } | null }))
vi.mock('../../server/utils/access/config', () => ({
  accessConfig: () => ({ kanidm: settings.kanidm }),
}))

// The per-actor limit has its own tests (admin-guard.test.ts).
vi.mock('../../server/utils/api/admin-limit', () => ({
  createAdminLimiter: () => ({ take: () => null }),
}))

const BOB = '11111111-1111-4111-8111-111111111111'
const CARA = '22222222-2222-4222-8222-222222222222'
const GHOST = '33333333-3333-4333-8333-333333333333'

let db: Database
let handle: (request: Request) => Promise<Response>
let userinfoGroups: string[]
let kanidmGroups: Record<string, string[] | null>
let kanidmDown: boolean
let groupLookups: string[]
const changed = vi.fn()

function addCalendar(name: string, ownerId: number | null = null): number {
  return Number(
    db
      .prepare('INSERT INTO calendars (name, kind, owner_id, collection_path) VALUES (?, ?, ?, ?)')
      .run(name, ownerId === null ? 'shared' : 'personal', ownerId, `/${name}/`).lastInsertRowid,
  )
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  userinfoGroups = ['calendar_admins']
  kanidmGroups = { staff: [] }
  kanidmDown = false
  groupLookups = []
  settings.kanidm = { origin: 'https://idm.test', token: SYNC_TOKEN }
  changed.mockReset()
  setAccessPorts({ onAclChanged: changed })
  upsertUser(db, { sub: BOB, username: 'bob', name: 'Bob Builder', email: 'bob@example.org' })
  upsertUser(db, { sub: CARA, username: 'cara' })

  const router = createRouter()
  router.add('/api/admin/access/calendars', calendarsGet, 'get')
  router.add('/api/admin/access/calendars/:id', calendarsPut, 'put')
  router.add('/api/admin/access/users', usersGet, 'get')
  handle = toWebHandler(createApp().use(router))

  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://idm.test/v1/group/')) {
        if (kanidmDown) throw new TypeError('fetch failed')
        const name = decodeURIComponent(url.slice('https://idm.test/v1/group/'.length))
        groupLookups.push(name)
        const members = kanidmGroups[name]
        if (!members) return new Response('null', { status: 200 })
        return new Response(JSON.stringify({ attrs: { name: [name], member: members } }))
      }
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      const who = auth.replace(/^Bearer test-/, '')
      return new Response(JSON.stringify({ sub: `sub-${who}`, groups: userinfoGroups }))
    }),
  )
  getUserinfoClient().clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setAccessPorts(undefined)
  db.close()
})

function call(method: string, path: string, body?: unknown, who = 'alice') {
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer test-${who}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const put = (id: number | string, rules: unknown, who = 'alice') =>
  call('PUT', `/api/admin/access/calendars/${id}`, { rules }, who)

const read = (who = 'alice') => call('GET', '/api/admin/access/calendars', undefined, who)

describe('who may call it', () => {
  it('refuses a user who is not in the admin group, on every route', async () => {
    userinfoGroups = ['staff']
    const id = addCalendar('Team')
    expect((await read()).status).toBe(403)
    expect((await call('GET', '/api/admin/access/users')).status).toBe(403)
    expect((await put(id, [{ principalType: 'authenticated', permission: 'read' }])).status).toBe(
      403,
    )
    expect(listCalendarAcl(db, id)).toEqual([])
    expect(listAuditEntries(db, {})).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it('ignores an isAdmin forged in the body or stored in the users table', async () => {
    userinfoGroups = []
    db.prepare('UPDATE users SET is_admin = 1').run()
    const id = addCalendar('Team')
    const response = await call('PUT', `/api/admin/access/calendars/${id}`, {
      isAdmin: true,
      admin: true,
      rules: [{ principalType: 'authenticated', permission: 'read' }],
    })
    expect(response.status).toBe(403)
    expect(listCalendarAcl(db, id)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it('needs a signed-in caller', async () => {
    const response = await handle(new Request('http://localhost/api/admin/access/calendars'))
    expect(response.status).toBe(401)
  })
})

describe('reading', () => {
  it('lists the calendars with their rules and whether each is applied', async () => {
    const bob = upsertUser(db, { sub: BOB }).id
    const team = addCalendar('Team')
    addCalendar('Alpha', bob)
    const rule = addCalendarAcl(db, team, {
      principalType: 'user',
      principal: BOB,
      permission: 'read',
    })
    addCalendarAcl(db, team, { principalType: 'group', principal: 'staff', permission: 'write' })
    markCalendarAclApplied(db, [rule.id], new Date('2026-11-01T10:00:00Z'))

    const body = (await (await read()).json()) as {
      groupsAvailable: boolean
      calendars: { name: string; owner: string | null; rules: Record<string, unknown>[] }[]
    }
    expect(body.groupsAvailable).toBe(true)
    expect(body.calendars.map((c) => [c.name, c.owner])).toEqual([
      ['Alpha', 'Bob Builder'],
      ['Team', null],
    ])
    expect(body.calendars[1]?.rules).toEqual([
      expect.objectContaining({
        principalType: 'user',
        principal: BOB,
        label: 'Bob Builder',
        permission: 'read',
        applied: true,
        appliedAt: '2026-11-01T10:00:00.000Z',
      }),
      expect.objectContaining({
        principalType: 'group',
        label: 'staff',
        permission: 'write',
        applied: false,
        appliedAt: null,
      }),
    ])
  })

  it('says groups are unavailable without a Kanidm token', async () => {
    settings.kanidm = null
    const body = (await (await read()).json()) as { groupsAvailable: boolean }
    expect(body.groupsAvailable).toBe(false)
  })

  it('gives the picker names and usernames only', async () => {
    const body = (await (await call('GET', '/api/admin/access/users')).json()) as {
      users: Record<string, unknown>[]
    }
    expect(body.users).toEqual([
      { sub: BOB, name: 'Bob Builder', username: 'bob' },
      { sub: CARA, name: null, username: 'cara' },
      { sub: 'sub-alice', name: null, username: null },
    ])
    expect(JSON.stringify(body)).not.toContain('bob@example.org')
  })
})

describe('replacing the rules', () => {
  it('stores them, audits the change without names and calls the port once', async () => {
    const id = addCalendar('Team')
    const response = await put(id, [
      { principalType: 'user', principal: BOB, permission: 'read' },
      { principalType: 'group', principal: 'staff', permission: 'free_busy' },
      { principalType: 'authenticated', permission: 'free_busy' },
    ])
    expect(response.status).toBe(200)
    const body = (await response.json()) as { changed: boolean; calendar: { rules: unknown[] } }
    expect(body.changed).toBe(true)
    expect(body.calendar.rules).toHaveLength(3)
    expect(
      listCalendarAcl(db, id).map((r) => [r.principal_type, r.principal, r.permission]),
    ).toEqual([
      ['user', BOB, 'read'],
      ['group', 'staff', 'free_busy'],
      ['authenticated', null, 'free_busy'],
    ])
    expect(changed).toHaveBeenCalledTimes(1)
    const [entry, ...rest] = listAuditEntries(db, {})
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      actor_sub: 'sub-alice',
      action: 'acl.replaced',
      target: `calendar:${id}`,
    })
    expect(JSON.parse(entry?.details ?? '{}')).toEqual({
      before: 0,
      after: 3,
      added: 3,
      removed: 0,
      principalTypes: { authenticated: 1, group: 1, user: 1 },
    })
    expect(entry?.details).not.toContain(BOB)
    expect(entry?.details).not.toContain(SYNC_TOKEN)
  })

  it('keeps applied_at of a rule that stays and unapplies a changed one', async () => {
    const id = addCalendar('Team')
    const keep = addCalendarAcl(db, id, {
      principalType: 'user',
      principal: BOB,
      permission: 'read',
    })
    const change = addCalendarAcl(db, id, {
      principalType: 'user',
      principal: CARA,
      permission: 'read',
    })
    markCalendarAclApplied(db, [keep.id, change.id])
    const response = await put(id, [
      { principalType: 'user', principal: BOB, permission: 'read' },
      { principalType: 'user', principal: CARA, permission: 'write' },
    ])
    expect(response.status).toBe(200)
    const rows = listCalendarAcl(db, id)
    expect(rows.map((r) => r.applied_at !== null)).toEqual([true, false])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('does nothing and stays quiet when the rules are the same', async () => {
    const id = addCalendar('Team')
    const rules = [{ principalType: 'user', principal: BOB, permission: 'read' }]
    await put(id, rules)
    changed.mockClear()
    const again = await put(id, rules)
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(listAuditEntries(db, {})).toHaveLength(1)
  })

  it('removes rules with an empty list', async () => {
    const id = addCalendar('Team')
    addCalendarAcl(db, id, { principalType: 'authenticated', principal: null, permission: 'read' })
    expect((await put(id, [])).status).toBe(200)
    expect(listCalendarAcl(db, id)).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(JSON.parse(listAuditEntries(db, {})[0]?.details ?? '{}')).toMatchObject({ removed: 1 })
  })

  it('still answers when the port throws', async () => {
    changed.mockImplementation(() => {
      throw new Error('boom')
    })
    const id = addCalendar('Team')
    const response = await put(id, [{ principalType: 'authenticated', permission: 'read' }])
    expect(response.status).toBe(200)
    expect(listCalendarAcl(db, id)).toHaveLength(1)
  })

  it('answers 404 for a calendar that does not exist or an id that is no number', async () => {
    const rules = [{ principalType: 'authenticated', permission: 'read' }]
    expect((await put(999, rules)).status).toBe(404)
    expect((await put('abc', rules)).status).toBe(404)
    expect((await put('1; DROP TABLE users', rules)).status).toBe(404)
  })
})

describe('what is refused', () => {
  const refused: [string, unknown][] = [
    ['no list', undefined],
    ['a text instead of a list', 'read'],
    ['a rule that is no object', ['bob']],
    ['the admin permission', [{ principalType: 'authenticated', permission: 'admin' }]],
    ['an unknown permission', [{ principalType: 'authenticated', permission: 'rw' }]],
    ['the public level', [{ principalType: 'public', permission: 'read' }]],
    ['an unknown principal type', [{ principalType: 'role', principal: 'x', permission: 'read' }]],
    [
      'a user name instead of an id',
      [{ principalType: 'user', principal: 'bob', permission: 'read' }],
    ],
    ['a user without principal', [{ principalType: 'user', permission: 'read' }]],
    [
      'a group name with a slash',
      [{ principalType: 'group', principal: 'a/b', permission: 'read' }],
    ],
    ['a group SPN', [{ principalType: 'group', principal: 'staff@idm.test', permission: 'read' }]],
    [
      'a principal for everyone',
      [{ principalType: 'authenticated', principal: 'x', permission: 'read' }],
    ],
    [
      'two rules for one principal',
      [
        { principalType: 'user', principal: BOB, permission: 'read' },
        { principalType: 'user', principal: BOB.toUpperCase(), permission: 'write' },
      ],
    ],
    ['far too many rules', Array.from({ length: 201 }, () => ({}))],
  ]

  it.each(refused)('answers 400 and changes nothing for %s', async (_label, rules) => {
    const id = addCalendar('Team')
    addCalendarAcl(db, id, { principalType: 'authenticated', principal: null, permission: 'read' })
    const response = await put(id, rules)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { data: { fields: { field: string }[] } }
    expect(body.data.fields.length).toBeGreaterThan(0)
    expect(listCalendarAcl(db, id)).toHaveLength(1)
    expect(listAuditEntries(db, {})).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it('refuses a person who never signed in, naming the rule', async () => {
    const id = addCalendar('Team')
    const response = await put(id, [
      { principalType: 'user', principal: BOB, permission: 'read' },
      { principalType: 'user', principal: GHOST, permission: 'read' },
    ])
    expect(response.status).toBe(400)
    const body = (await response.json()) as { data: { fields: { field: string }[] } }
    expect(body.data.fields.map((f) => f.field)).toEqual(['rules[1].principal'])
    expect(listCalendarAcl(db, id)).toEqual([])
  })

  it('refuses a rule for the owner of the calendar', async () => {
    const bob = upsertUser(db, { sub: BOB }).id
    const id = addCalendar('Mine', bob)
    const response = await put(id, [{ principalType: 'user', principal: BOB, permission: 'read' }])
    expect(response.status).toBe(400)
    expect(listCalendarAcl(db, id)).toEqual([])
  })
})

describe('groups', () => {
  const staff = [{ principalType: 'group', principal: 'staff', permission: 'read' }]

  it('accepts a group Kanidm knows, asking with the sync token', async () => {
    const id = addCalendar('Team')
    expect((await put(id, staff)).status).toBe(200)
    expect(groupLookups).toEqual(['staff'])
    const sent = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/v1/group/'))
    expect(new Headers(sent?.[1]?.headers).get('authorization')).toBe(`Bearer ${SYNC_TOKEN}`)
  })

  it('refuses a group Kanidm does not know or hides', async () => {
    const id = addCalendar('Team')
    const response = await put(id, [
      { principalType: 'group', principal: 'nope', permission: 'read' },
    ])
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('not a Kanidm group')
    expect(listCalendarAcl(db, id)).toEqual([])
  })

  it('refuses every group rule when no sync token is configured, and says why', async () => {
    settings.kanidm = null
    const id = addCalendar('Team')
    const response = await put(id, staff)
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('sync token is not configured')
    expect(groupLookups).toEqual([])
    expect(listCalendarAcl(db, id)).toEqual([])
  })

  it('answers 409 and stores nothing when Kanidm cannot be reached', async () => {
    kanidmDown = true
    const id = addCalendar('Team')
    const response = await put(id, staff)
    expect(response.status).toBe(409)
    expect(listCalendarAcl(db, id)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
    expect(JSON.stringify(await response.clone().json())).not.toContain(SYNC_TOKEN)
  })

  it('does not ask again about a group that already has a rule', async () => {
    const id = addCalendar('Team')
    addCalendarAcl(db, id, { principalType: 'group', principal: 'old_group', permission: 'read' })
    kanidmDown = true
    const response = await put(id, [
      { principalType: 'group', principal: 'old_group', permission: 'write' },
    ])
    expect(response.status).toBe(200)
    expect(groupLookups).toEqual([])
  })
})
