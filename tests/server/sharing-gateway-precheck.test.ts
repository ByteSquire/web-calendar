// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addCalendarAcl } from '../../server/db/calendar-acl'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { createGateway } from '../../server/utils/gateway/gateway'
import { parseGroupFile, type GroupMembership } from '../../server/utils/sharing/membership'
import { createPathPrecheck } from '../../server/utils/sharing/precheck'

const ALICE = '8f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77'
const BOB = '3d9a7e51-0c2b-4f86-b1aa-6e4d8c0f9a12'
const EVE = '5b2e9c14-6a3d-4e08-8f71-2c9d4a7b1e30'

let db: Database
let calendarId: number

const members = parseGroupFile(`web_calendar_users: ${ALICE} ${BOB} ${EVE}\nteam: ${EVE}\n`)
const membership: GroupMembership = {
  groupsOf: async (sub) => members.get(sub) ?? new Set<string>(),
  all: async () => members,
}

beforeEach(() => {
  db = openDatabase(':memory:')
  runMigrations(
    db,
    loadMigrationsFromDir(fileURLToPath(new URL('../../server/db/migrations', import.meta.url))),
  )
  calendarId = Number(
    db
      .prepare("INSERT INTO calendars (name, kind, collection_path) VALUES ('work', 'shared', ?)")
      .run(`/${ALICE}/work/`).lastInsertRowid,
  )
  addCalendarAcl(db, calendarId, { principalType: 'user', principal: BOB, permission: 'read' })
  addCalendarAcl(db, calendarId, { principalType: 'group', principal: 'team', permission: 'write' })
})

afterEach(() => db.close())

describe('path pre-check', () => {
  it("allows the root and the caller's own home and calendars", async () => {
    const check = createPathPrecheck(db, membership)
    for (const upstreamPath of ['/', `/${ALICE}/`, `/${ALICE}/work/`, `/${ALICE}/work/x.ics`]) {
      expect(await check(ALICE, { method: 'PROPFIND', upstreamPath })).toBe(true)
    }
  })

  it('allows a grantee on the shared name in their home and denies a stranger', async () => {
    const check = createPathPrecheck(db, membership)
    const path = `/${BOB}/shared-${calendarId}/event.ics`
    expect(await check(BOB, { method: 'GET', upstreamPath: path })).toBe(true)
    // A rule-less caller does not get the name, nor does the grantee get another calendar's.
    expect(
      await check(ALICE, { method: 'GET', upstreamPath: `/${ALICE}/shared-${calendarId}/x.ics` }),
    ).toBe(false)
    expect(
      await check(BOB, { method: 'GET', upstreamPath: `/${BOB}/shared-${calendarId + 1}/` }),
    ).toBe(false)
  })

  it('applies the method: read cannot write, a group member with write can', async () => {
    const check = createPathPrecheck(db, membership)
    const bob = `/${BOB}/shared-${calendarId}/x.ics`
    expect(await check(BOB, { method: 'PUT', upstreamPath: bob })).toBe(false)
    const eve = `/${EVE}/shared-${calendarId}-team/x.ics`
    expect(await check(EVE, { method: 'PUT', upstreamPath: eve })).toBe(true)
  })

  it("denies another principal's home and calendars without a rule", async () => {
    const check = createPathPrecheck(db, membership)
    expect(await check(BOB, { method: 'PROPFIND', upstreamPath: `/${ALICE}/` })).toBe(false)
    expect(await check(BOB, { method: 'PROPFIND', upstreamPath: `/${ALICE}/other/` })).toBe(false)
    expect(
      await check(BOB, { method: 'PROPFIND', upstreamPath: '/_resources/availability/' }),
    ).toBe(false)
    // With a rule, direct access to the owner's path passes the pre-check (Radicale decides).
    expect(await check(BOB, { method: 'PROPFIND', upstreamPath: `/${ALICE}/work/` })).toBe(true)
    expect(await check(EVE, { method: 'GET', upstreamPath: `/${ALICE}/work/x.ics` })).toBe(true)
  })

  it('lets every authenticated caller see the availability share, read-only', async () => {
    const check = createPathPrecheck(db, membership)
    const path = `/${BOB}/resource-availability/x.ics`
    expect(await check(BOB, { method: 'GET', upstreamPath: path })).toBe(true)
    expect(await check(BOB, { method: 'PUT', upstreamPath: path })).toBe(false)
    // A person who signed in a moment ago is not in the group file yet; the share is theirs too.
    const stranger = '11111111-1111-4111-8111-111111111111'
    expect(
      await check(stranger, {
        method: 'GET',
        upstreamPath: `/${stranger}/resource-availability/`,
      }),
    ).toBe(true)
    // It is still only their own home's name.
    expect(await check(stranger, { method: 'GET', upstreamPath: path })).toBe(false)
  })

  it('grants an authenticated rule to anybody, without reading the group file', async () => {
    const everyone = Number(
      db
        .prepare("INSERT INTO calendars (name, kind, collection_path) VALUES ('open', 'shared', ?)")
        .run(`/${ALICE}/open/`).lastInsertRowid,
    )
    addCalendarAcl(db, everyone, {
      principalType: 'authenticated',
      principal: null,
      permission: 'read',
    })
    const groupsOf = vi.fn(async () => new Set<string>())
    const check = createPathPrecheck(db, { groupsOf, all: async () => new Map() })
    const newcomer = '22222222-2222-4222-8222-222222222222'
    expect(
      await check(newcomer, {
        method: 'GET',
        upstreamPath: `/${newcomer}/shared-${everyone}/x.ics`,
      }),
    ).toBe(true)
    // Read only, as the rule says.
    expect(
      await check(newcomer, {
        method: 'PUT',
        upstreamPath: `/${newcomer}/shared-${everyone}/x.ics`,
      }),
    ).toBe(false)
    expect(groupsOf).not.toHaveBeenCalled()
  })

  it('still asks the group file for a group rule, also for the group of everyone', async () => {
    const calendar = Number(
      db
        .prepare("INSERT INTO calendars (name, kind, collection_path) VALUES ('all', 'shared', ?)")
        .run(`/${ALICE}/all/`).lastInsertRowid,
    )
    addCalendarAcl(db, calendar, {
      principalType: 'group',
      principal: 'web_calendar_users',
      permission: 'read',
    })
    const check = createPathPrecheck(db, membership)
    const path = (sub: string) => ({
      method: 'GET',
      upstreamPath: `/${sub}/shared-${calendar}/x.ics`,
    })
    expect(await check(BOB, path(BOB))).toBe(true)
    const newcomer = '22222222-2222-4222-8222-222222222222'
    expect(await check(newcomer, path(newcomer))).toBe(false)
  })

  it('tells ids apart by case, as Radicale does', async () => {
    const carol = 'Carol@Example.org'
    addCalendarAcl(db, calendarId, { principalType: 'user', principal: carol, permission: 'read' })
    const check = createPathPrecheck(db, membership)
    const path = (home: string) => `/${home}/shared-${calendarId}/x.ics`
    expect(await check(carol, { method: 'GET', upstreamPath: path(carol) })).toBe(true)
    const lower = carol.toLowerCase()
    expect(await check(lower, { method: 'GET', upstreamPath: path(lower) })).toBe(false)
  })

  it('reads the members of the group file case-sensitively', () => {
    const parsed = parseGroupFile('team: Ab ab auth0|1 Alice@Example.org\n')
    expect([...parsed.keys()]).toEqual(['Ab', 'ab', 'auth0|1', 'Alice@Example.org'])
  })
})

describe('gateway with the pre-check', () => {
  function setup() {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 207 }))
    const handle = createGateway({
      upstream: 'http://radicale:5232',
      maxBodyBytes: 1000,
      authenticate: async () => ({ sub: BOB }),
      precheck: createPathPrecheck(db, membership),
      fetch: fetchStub as unknown as typeof fetch,
    })
    const call = (method: string, target: string, headers: Record<string, string> = {}) =>
      handle({ method, target, headers: new Headers(headers), body: null })
    return { call, fetchStub }
  }

  it('forwards the owner path and the grantee path, denies others with 403', async () => {
    const { call, fetchStub } = setup()
    expect((await call('PROPFIND', `/caldav/${BOB}/`)).status).toBe(207)
    expect((await call('PROPFIND', `/caldav/${BOB}/shared-${calendarId}/`)).status).toBe(207)
    expect((await call('PROPFIND', '/caldav/')).status).toBe(207)
    fetchStub.mockClear()
    const denied = await call('PROPFIND', `/caldav/${ALICE}/private/`)
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe('Forbidden')
    expect((await call('PROPFIND', `/caldav/${EVE}/`)).status).toBe(403)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('checks the Destination of a MOVE too', async () => {
    const { call, fetchStub } = setup()
    const response = await call('MOVE', `/caldav/${BOB}/a/x.ics`, {
      destination: `/caldav/${ALICE}/private/x.ics`,
    })
    expect(response.status).toBe(403)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('keeps /caldav/.sharing/** at 404, before any pre-check or request', async () => {
    const { call, fetchStub } = setup()
    for (const target of [
      '/caldav/.sharing',
      '/caldav/.sharing/v1/map/list',
      '/caldav/.sharing/v1/token/create',
    ]) {
      expect((await call('GET', target)).status).toBe(404)
    }
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
