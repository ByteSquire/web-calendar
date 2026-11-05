// @vitest-environment node
// A group calendar in the sharing writer and at the gateway: the owning group's write rule becomes a
// share from the group principal; extra user and group shares are read or write; the gateway's
// pre-check lets the owning group's members in, lets a read-only grantee read but not write, and
// refuses an outsider.
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCalendarAcl, listAllCalendarAcl } from '../../server/db/calendar-acl'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import type { CalendarRow } from '../../server/db/types'
import { computeDesiredShares } from '../../server/utils/sharing/desired'
import { parseGroupFile, type GroupMembership } from '../../server/utils/sharing/membership'
import { createPathPrecheck } from '../../server/utils/sharing/precheck'

const ALICE = '8f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77' // member of team_a (the owning group)
const BOB = '3d9a7e51-0c2b-4f86-b1aa-6e4d8c0f9a12' // member of team_b (a write share)
const CARA = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' // a read-only user share
const EVE = '5b2e9c14-6a3d-4e08-8f71-2c9d4a7b1e30' // nobody

const COLLECTION = '/_group-1/0c1d2e3f-4a5b-4c6d-8e7f-900112233445/'
let db: Database
let calendarId: number

const members = parseGroupFile(`team_a: ${ALICE}\nteam_b: ${BOB}\n`)
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
  const group = Number(
    db.prepare(`INSERT INTO groups (name, source) VALUES ('team_a', 'app')`).run().lastInsertRowid,
  )
  calendarId = Number(
    db
      .prepare(
        `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id)
         VALUES ('Team', 'shared', NULL, ?, ?)`,
      )
      .run(COLLECTION, group).lastInsertRowid,
  )
  addCalendarAcl(db, calendarId, {
    principalType: 'group',
    principal: 'team_a',
    permission: 'write',
  })
  addCalendarAcl(db, calendarId, {
    principalType: 'group',
    principal: 'team_b',
    permission: 'write',
  })
  addCalendarAcl(db, calendarId, { principalType: 'user', principal: CARA, permission: 'read' })
})

afterEach(() => db.close())

function desired() {
  const calendars = new Map(
    db
      .prepare<[], CalendarRow>('SELECT * FROM calendars')
      .all()
      .map((row) => [row.id, row]),
  )
  return computeDesiredShares(listAllCalendarAcl(db), calendars).shares
}

describe('desired shares of a group calendar', () => {
  it('shares the owning group rule from the group principal, and the extras as the rules say', () => {
    const shares = desired().map((share) => ({
      owner: share.owner,
      kind: share.kind,
      user: share.user,
      permissions: share.permissions,
    }))
    expect(shares).toEqual(
      expect.arrayContaining([
        // Radicale's names: a group share is `:group` with `rw` (write) or `r` (read).
        { owner: '_group-1', kind: 'group', user: ':team_a', permissions: 'rw' },
        { owner: '_group-1', kind: 'group', user: ':team_b', permissions: 'rw' },
        { owner: '_group-1', kind: 'user', user: CARA, permissions: 'r' },
      ]),
    )
    expect(shares).toHaveLength(3)
  })

  it('gives a read-only user share the read permission, never write', () => {
    const cara = desired().find((share) => share.user === CARA)!
    expect(cara.permissions).toBe('r')
  })
})

describe('gateway pre-check of a group calendar', () => {
  const path = `/_group-1/0c1d2e3f-4a5b-4c6d-8e7f-900112233445/event.ics`
  const shared = (sub: string) => `/${sub}/shared-${calendarId}/event.ics`

  it('lets a member of the owning group read and write the calendar', async () => {
    const check = createPathPrecheck(db, membership)
    expect(await check(ALICE, { method: 'PUT', upstreamPath: path })).toBe(true)
    expect(await check(ALICE, { method: 'PUT', upstreamPath: shared(ALICE) })).toBe(true)
  })

  it('lets a member of a write-shared group in, and a read-only grantee read but not write', async () => {
    const check = createPathPrecheck(db, membership)
    expect(await check(BOB, { method: 'PUT', upstreamPath: path })).toBe(true)
    expect(await check(CARA, { method: 'GET', upstreamPath: path })).toBe(true)
    expect(await check(CARA, { method: 'PUT', upstreamPath: path })).toBe(false)
  })

  it('refuses an outsider, and anybody on a calendar the rules do not grant', async () => {
    const check = createPathPrecheck(db, membership)
    expect(await check(EVE, { method: 'GET', upstreamPath: path })).toBe(false)
    expect(await check(EVE, { method: 'GET', upstreamPath: shared(EVE) })).toBe(false)
  })
})

// Providers other than Kanidm send ids with capitals and symbols; Radicale tells `Ab` and `ab` apart.
describe('ids as the provider sends them', () => {
  const DORA = 'Dora@Example.org'

  it('keeps a mixed-case user share exact in the desired shares and at the gateway', async () => {
    addCalendarAcl(db, calendarId, { principalType: 'user', principal: DORA, permission: 'read' })
    expect(desired().find((share) => share.user === DORA)?.permissions).toBe('r')
    const check = createPathPrecheck(db, membership)
    const read = (sub: string) => ({
      method: 'GET',
      upstreamPath: `/${sub}/shared-${calendarId}/event.ics`,
    })
    expect(await check(DORA, read(DORA))).toBe(true)
    expect(await check(DORA.toLowerCase(), read(DORA.toLowerCase()))).toBe(false)
  })

  it('tells group members apart by case', async () => {
    const file = parseGroupFile(`team_a: ${DORA}\n`)
    const check = createPathPrecheck(db, {
      groupsOf: async (sub) => file.get(sub) ?? new Set<string>(),
      all: async () => file,
    })
    const request = { method: 'PUT', upstreamPath: `${COLLECTION}event.ics` }
    expect(await check(DORA, request)).toBe(true)
    expect(await check(DORA.toUpperCase(), request)).toBe(false)
    expect(await check(DORA.toLowerCase(), request)).toBe(false)
  })
})

// Radicale makes a home, with its default calendar, on the first request as that account. For a
// user that default is their personal calendar; for a group it would be a calendar nobody made.
describe('discovery in a group home', () => {
  it('skips the default calendar Radicale creates, and adopts a calendar the group made', async () => {
    const { startFakeRadicale } = await import('./sharing-fake-radicale')
    const { createRadicaleClient } = await import('../../server/utils/sharing/radicale-client')
    const { discoverCalendars } = await import('../../server/utils/sharing/calendars')
    const radicale = await startFakeRadicale()
    try {
      db.prepare('DELETE FROM calendars').run()
      radicale.calendars.set('_group-1', new Set(['def-calendar', 'kitchen']))
      const client = createRadicaleClient({ baseUrl: radicale.url })
      const result = await discoverCalendars(db, client, [])
      expect(result.ok).toBe(true)
      const rows = db
        .prepare('SELECT collection_path AS path, group_id AS groupId FROM calendars')
        .all()
      expect(rows).toEqual([{ path: '/_group-1/kitchen/', groupId: 1 }])
    } finally {
      await radicale.close()
    }
  })
})
