// @vitest-environment node
// The admin access route (PUT /api/admin/access/calendars/:id) and the groups: a group calendar keeps
// its owning group's write rule, and a group named in `groups` is accepted without a Kanidm call.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import calendarsPut from '../../server/api/admin/access/calendars/[id].put'
import { addCalendarAcl, listCalendarAcl } from '../../server/db/calendar-acl'
import { setAccessPorts } from '../../server/utils/access/ports'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { setDb } from '../../server/utils/db'
import { openTestDb, seedUserinfoEndpoint } from './api-fixtures'

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
    signinWindowMs: 30 * 24 * 60 * 60 * 1000,
  }),
}))

vi.mock('../../server/utils/api/admin-limit', () => ({
  createAdminLimiter: () => ({ take: () => null }),
}))

let db: Database
let handle: (request: Request) => Promise<Response>
const changed = vi.fn()

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  setAccessPorts({ onAclChanged: changed })
  getUserinfoClient().clear()
  seedUserinfoEndpoint()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ sub: 'sub-admin', groups: ['calendar_admins'] })),
    ),
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const router = createRouter()
  router.add('/api/admin/access/calendars/:id', calendarsPut, 'put')
  handle = toWebHandler(createApp().use(router))
  db.prepare(`INSERT INTO groups (name, source) VALUES ('team_a', 'app')`).run()
  db.prepare(
    `INSERT INTO groups (name, source, external_id) VALUES ('staff', 'oidc', 'staff-id')`,
  ).run()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setAccessPorts(undefined)
  db.close()
})

function groupCalendar(): number {
  const group = Number(db.prepare(`SELECT id FROM groups WHERE name = 'team_a'`).pluck().get())
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id)
         VALUES ('Team', 'shared', NULL, ?, ?)`,
      )
      .run(`/_group-${group}/cal/`, group).lastInsertRowid,
  )
  addCalendarAcl(db, id, { principalType: 'group', principal: 'team_a', permission: 'write' })
  return id
}

function put(id: number, rules: unknown) {
  return handle(
    new Request(`http://localhost/api/admin/access/calendars/${id}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ rules }),
    }),
  )
}

describe('the owning group of a group calendar', () => {
  it('refuses a rule list that drops the owning group write rule, with a field message', async () => {
    const id = groupCalendar()
    const res = await put(id, [
      { principalType: 'authenticated', principal: null, permission: 'read' },
    ])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { data: { fields: { field: string; message: string }[] } }
    expect(body.data.fields[0]!.field).toBe('rules')
    expect(body.data.fields[0]!.message).toMatch(/keep the write rule of the owning group "team_a"/)
    // Nothing was changed: the rule is still there, and no reconcile was asked for.
    expect(listCalendarAcl(db, id).map((row) => row.principal)).toEqual(['team_a'])
    expect(changed).not.toHaveBeenCalled()
  })

  it('accepts the rule list when the owning rule stays, with an extra share', async () => {
    const id = groupCalendar()
    const res = await put(id, [
      { principalType: 'group', principal: 'team_a', permission: 'write' },
      { principalType: 'group', principal: 'staff', permission: 'read' },
    ])
    expect(res.status).toBe(200)
    expect(changed).toHaveBeenCalled()
  })

  it('accepts a group of the app (in `groups`) without a Kanidm call, and refuses an unknown one', async () => {
    const id = groupCalendar()
    const kept = await put(id, [
      { principalType: 'group', principal: 'team_a', permission: 'write' },
      { principalType: 'group', principal: 'staff', permission: 'read' },
    ])
    expect(kept.status).toBe(200)
    const unknown = await put(id, [
      { principalType: 'group', principal: 'team_a', permission: 'write' },
      { principalType: 'group', principal: 'nobody', permission: 'read' },
    ])
    expect(unknown.status).toBe(400)
  })
})
