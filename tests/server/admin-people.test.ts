// @vitest-environment node
// Admin › People as HTTP: the list of everybody who signed in and the detail of one person (groups,
// own calendars, calendars shared with them, links they made), admin only, with no e-mail address
// and no link secrets.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import peopleGet from '../../server/api/admin/people/index.get'
import personGet from '../../server/api/admin/people/[id].get'
import { upsertUser } from '../../server/db/users'
import { setDb } from '../../server/utils/db'
import { setGroupsPorts, type GroupsPorts } from '../../server/utils/groups/ports'
import type { RadicaleClient } from '../../server/utils/sharing/radicale-client'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { openTestDb, seedUserinfoEndpoint } from './api-fixtures'

// Who is who: the bearer name maps to a fixed sub (a UUID).
const SUBS = {
  alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e', // signed in, owns a calendar
  bob: '6f9f0e2d-0000-4000-8000-000000000002', // signed in, nothing special
  admin: '11111111-1111-4111-8111-111111111111', // in the admin group
} as const
type Who = keyof typeof SUBS
const ADMIN_GROUP = 'calendar_admins'

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  const subs: Record<string, string> = {
    alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
    bob: '6f9f0e2d-0000-4000-8000-000000000002',
    admin: '11111111-1111-4111-8111-111111111111',
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
    groupsIgnore: ['idm_*', 'system_*'],
    signinWindowMs: 30 * 24 * 60 * 60 * 1000,
  }),
}))

// The per-actor limit has its own tests (admin-guard.test.ts).
vi.mock('../../server/utils/api/admin-limit', () => ({
  createAdminLimiter: () => ({ take: () => null }),
}))

const ROUTES: [method: string, path: string, handler: EventHandler][] = [
  ['GET', '/api/admin/people', peopleGet],
  ['GET', '/api/admin/people/:id', personGet],
]

let db: Database
let handle: (request: Request) => Promise<Response>
let radicale: Record<
  'makeCalendar' | 'updateCalendar' | 'deleteCollection' | 'listShares' | 'deleteShare',
  ReturnType<typeof vi.fn>
>
let ports: GroupsPorts & { onSharesChanged: ReturnType<typeof vi.fn> }
const ok = { ok: true, value: undefined } as const
let userIds: Record<Who, number>

function call(method: string, path: string, who: Who | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (who) headers.authorization = `Bearer test-${who}`
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  userIds = {
    alice: upsertUser(db, {
      sub: SUBS.alice,
      username: 'alice',
      name: 'Alice Ann',
      email: 'alice@example.org',
    }).id,
    bob: upsertUser(db, { sub: SUBS.bob, username: 'bob', name: 'Bob' }).id,
    admin: upsertUser(db, { sub: SUBS.admin, username: 'admin' }).id,
  }
  radicale = {
    makeCalendar: vi.fn(async () => ok),
    updateCalendar: vi.fn(async () => ok),
    deleteCollection: vi.fn(async () => ok),
    listShares: vi.fn(async () => ({ ok: true, value: [] })),
    deleteShare: vi.fn(async () => ok),
  }
  ports = {
    radicale: () => radicale as unknown as RadicaleClient,
    onGroupsChanged: vi.fn(),
    onSharesChanged: vi.fn(),
  }
  setGroupsPorts(ports)
  getUserinfoClient().clear()
  seedUserinfoEndpoint()
  // The admin check asks the identity provider for the caller's groups.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_input, init) => {
      const who = new Headers(init?.headers).get('authorization')?.replace(/^Bearer test-/, '')
      const sub = who === 'admin' ? SUBS.admin : who === 'alice' ? SUBS.alice : SUBS.bob
      return new Response(JSON.stringify({ sub, groups: who === 'admin' ? [ADMIN_GROUP] : [] }))
    }),
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const router = createRouter()
  for (const [method, path, handler] of ROUTES) {
    router.add(path, handler, method.toLowerCase() as 'get')
  }
  handle = toWebHandler(createApp().use(router))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setGroupsPorts(undefined)
  db.close()
})

/** A calendar row; `owner` makes it a person's own, `group` a group's. */
function seedCalendar(
  path: string,
  {
    name = 'Cal',
    kind = 'shared',
    owner = null,
    group = null,
    color = null,
  }: {
    name?: string
    kind?: string
    owner?: Who | null
    group?: number | null
    color?: string | null
  } = {},
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id, color)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, kind, owner ? userIds[owner] : null, path, group, color).lastInsertRowid,
  )
}

describe('Admin › People', () => {
  it.each([
    ['GET', '/api/admin/people'],
    ['GET', '/api/admin/people/1'],
  ])('%s %s answers 401 anonymous and 403 for a non-admin', async (method, path) => {
    expect((await call(method, path, null)).status).toBe(401)
    expect((await call(method, path, 'alice')).status).toBe(403)
  })

  it('lists everybody without an e-mail address and mirrors the admin flag', async () => {
    db.prepare('UPDATE users SET is_admin = 1 WHERE oidc_sub = ?').run(SUBS.admin)
    const res = await call('GET', '/api/admin/people', 'admin')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      people: Record<string, unknown>[]
      truncated: boolean
    }
    expect(body.truncated).toBe(false)
    expect(body.people.map((p) => p.sub).sort()).toEqual([SUBS.alice, SUBS.bob, SUBS.admin].sort())
    expect(JSON.stringify(body)).not.toContain('@')
    expect(JSON.stringify(body)).not.toContain('email')
    for (const person of body.people) {
      expect(Object.keys(person).sort()).toEqual([
        'adminAtLastSignIn',
        'id',
        'lastSeenAt',
        'name',
        'sub',
        'username',
      ])
    }
    const flags = Object.fromEntries(body.people.map((p) => [p.username, p.adminAtLastSignIn]))
    expect(flags).toEqual({ alice: false, bob: false, admin: true })
    expect(body.people.find((p) => p.username === 'alice')).toMatchObject({
      id: userIds.alice,
      name: 'Alice Ann',
    })
  })

  it('shows a person with groups, own calendars, shared calendars and links, without secrets', async () => {
    const team = Number(
      db.prepare(`INSERT INTO groups (name, source) VALUES ('team_a', 'app')`).run()
        .lastInsertRowid,
    )
    db.prepare('INSERT INTO group_members (group_id, sub, manager) VALUES (?, ?, 1)').run(
      team,
      SUBS.alice,
    )
    const everyone = db
      .prepare<[], { id: number }>(`SELECT id FROM groups WHERE source = 'everyone'`)
      .get()!.id
    db.prepare('INSERT INTO group_members (group_id, sub, manager) VALUES (?, ?, 0)').run(
      everyone,
      SUBS.alice,
    )
    const own = seedCalendar(`/${SUBS.alice}/Mine/`, {
      name: 'Mine',
      kind: 'personal',
      owner: 'alice',
    })
    const bobs = seedCalendar(`/${SUBS.bob}/Bobs/`, {
      name: 'Bobs',
      kind: 'personal',
      owner: 'bob',
    })
    const hidden = seedCalendar(`/${SUBS.bob}/Hidden/`, {
      name: 'Hidden',
      kind: 'personal',
      owner: 'bob',
    })
    db.prepare(
      `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
       VALUES (?, 'user', ?, 'read')`,
    ).run(bobs, SUBS.alice)
    db.prepare(
      `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
       VALUES (?, 'user', ?, 'read')`,
    ).run(hidden, SUBS.admin)
    db.prepare(
      `INSERT INTO calendar_links
         (user_id, collection_path, calendar_name, label, slug_hash, password_hash, secret_sealed,
          level, calendar_id)
       VALUES (?, ?, 'Mine', 'For friends', ?, 'scrypt$SECRETHASH', ?, 'free_busy', ?)`,
    ).run(userIds.alice, `/${SUBS.alice}/Mine/`, 'ab'.repeat(32), 's1.' + 'x'.repeat(30), own)

    const res = await call('GET', `/api/admin/people/${userIds.alice}`, 'admin')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/slug|password|secret|SECRETHASH|alice@example\.org|abab/i)
    const body = JSON.parse(text) as Record<string, unknown>
    expect(body).toMatchObject({
      id: userIds.alice,
      sub: SUBS.alice,
      name: 'Alice Ann',
      username: 'alice',
      adminAtLastSignIn: false,
      groups: [
        { id: team, name: 'team_a', source: 'app', manager: true },
        { id: everyone, name: 'web_calendar_users', source: 'everyone', manager: false },
      ],
      calendars: [{ id: own, name: 'Mine' }],
      shared: [{ id: bobs, name: 'Bobs', kind: 'personal', owner: 'Bob' }],
    })
    const links = body.links as Record<string, unknown>[]
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      label: 'For friends',
      calendarName: 'Mine',
      level: 'free_busy',
      lastUsedAt: null,
    })
    expect(Object.keys(links[0]!).sort()).toEqual([
      'calendarName',
      'createdAt',
      'id',
      'label',
      'lastUsedAt',
      'level',
    ])
  })

  it('shows a person with nothing yet as empty lists', async () => {
    const body = (await (
      await call('GET', `/api/admin/people/${userIds.bob}`, 'admin')
    ).json()) as {
      calendars: unknown[]
      shared: unknown[]
      links: unknown[]
    }
    expect(body).toMatchObject({ calendars: [], shared: [], links: [] })
  })

  it('answers 404 for an unknown person or an id that is no number', async () => {
    expect((await call('GET', '/api/admin/people/9999', 'admin')).status).toBe(404)
    expect((await call('GET', '/api/admin/people/abc', 'admin')).status).toBe(404)
  })
})
