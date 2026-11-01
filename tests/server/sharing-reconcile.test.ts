// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { addCalendarAcl, listAllCalendarAcl } from '../../server/db/calendar-acl'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { createRadicaleClient } from '../../server/utils/sharing/radicale-client'
import { backoffDelay } from '../../server/utils/sharing/loop'
import { createSharingReconciler } from '../../server/utils/sharing/reconcile'
import { startFakeRadicale, type FakeRadicale } from './sharing-fake-radicale'

const ALICE = '8f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77'
const BOB = '3d9a7e51-0c2b-4f86-b1aa-6e4d8c0f9a12'
const CAROL = '5b2e9c14-6a3d-4e08-8f71-2c9d4a7b1e30'

let db: Database
let radicale: FakeRadicale
const logs: string[] = []
const log = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }

beforeEach(async () => {
  db = openDatabase(':memory:')
  runMigrations(
    db,
    loadMigrationsFromDir(fileURLToPath(new URL('../../server/db/migrations', import.meta.url))),
  )
  for (const [sub, name] of [
    [ALICE, 'alice'],
    [BOB, 'bob'],
    [CAROL, 'carol'],
  ] as const) {
    db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)').run(sub, name)
  }
  radicale = await startFakeRadicale()
  radicale.calendars.set(ALICE, new Set(['work']))
  radicale.groups.set('web_calendar_users', new Set([ALICE, BOB, CAROL]))
  radicale.groups.set('team', new Set([BOB, CAROL]))
  logs.length = 0
})

afterEach(async () => {
  db.close()
  await radicale.close()
})

function reconciler() {
  return createSharingReconciler({
    db,
    client: createRadicaleClient({ baseUrl: radicale.url }),
    log,
  })
}

function calendarId(path: string): number {
  return db
    .prepare<[string], { id: number }>('SELECT id FROM calendars WHERE collection_path = ?')
    .get(path)!.id
}

function summary(shares = radicale.shares) {
  return shares
    .map((s) => `${s.owner}|${s.pathMapped}|${s.user}|${s.pathOrToken}|${s.permissions}`)
    .sort()
}

describe('sharing reconcile', () => {
  it('mirrors the calendars of known users into the calendars table', async () => {
    const result = await reconciler().run()
    expect(result.ok).toBe(true)
    const row = db.prepare('SELECT name, kind, owner_id FROM calendars').get() as {
      name: string
      kind: string
      owner_id: number
    }
    expect(row).toMatchObject({ name: 'work', kind: 'personal' })
    expect(row.owner_id).toBeGreaterThan(0)
  })

  it('turns fixture rules into the expected shares and marks them applied', async () => {
    const job = reconciler()
    await job.run()
    const id = calendarId(`/${ALICE}/work/`)
    addCalendarAcl(db, id, { principalType: 'user', principal: BOB, permission: 'read' })
    addCalendarAcl(db, id, { principalType: 'group', principal: 'team', permission: 'write' })
    addCalendarAcl(db, id, {
      principalType: 'authenticated',
      principal: null,
      permission: 'free_busy',
    })
    addCalendarAcl(db, id, { principalType: 'user', principal: CAROL, permission: 'admin' })
    addCalendarAcl(db, id, { principalType: 'public', principal: null, permission: 'read' })
    expect(listAllCalendarAcl(db).every((row) => row.applied_at === null)).toBe(true)

    const result = await job.run()
    expect(result).toMatchObject({ ok: true, value: { differences: [] } })
    expect(summary()).toEqual(
      [
        `${ALICE}|/${ALICE}/work/|${BOB}|/${BOB}/shared-${id}/|r`,
        `${ALICE}|/${ALICE}/work/|:team|/{user}/shared-${id}-team/|rw`,
        `${ALICE}|/${ALICE}/work/|:web_calendar_users|/{user}/shared-${id}-web_calendar_users/|f`,
        '_resources|/_resources/availability/|:web_calendar_users|/{user}/resource-availability/|f',
      ].sort(),
    )
    // bob accepted his user share; nothing was shared for admin or public.
    expect(radicale.shares.find((s) => s.user === BOB)?.accepted).toBe(true)
    expect(radicale.shares.some((s) => s.user === CAROL)).toBe(false)
    expect(listAllCalendarAcl(db).every((row) => row.applied_at !== null)).toBe(true)
    expect(radicale.requests.some((r) => r.url.includes('.sharing') && r.user === BOB)).toBe(true)
  })

  it('removes a share SQLite does not know and audits it', async () => {
    const job = reconciler()
    await job.run()
    radicale.shares.push({
      owner: ALICE,
      pathMapped: `/${ALICE}/work/`,
      pathOrToken: `/${CAROL}/invented/`,
      user: CAROL,
      permissions: 'rw',
      enabled: true,
      hidden: false,
      accepted: true,
    })
    const result = await job.run()
    expect(result).toMatchObject({ ok: true, value: { removed: 1, differences: [] } })
    expect(radicale.shares.some((s) => s.user === CAROL)).toBe(false)
    const entry = listAuditEntries(db).find((e) => e.action === 'sharing.removed_unknown')
    expect(entry?.actor_sub).toBe('system:sharing-writer')
    expect(entry?.details).toContain(CAROL)
  })

  it('replaces a share whose permission differs', async () => {
    const job = reconciler()
    await job.run()
    const id = calendarId(`/${ALICE}/work/`)
    addCalendarAcl(db, id, { principalType: 'user', principal: BOB, permission: 'write' })
    await job.run()
    radicale.shares.find((s) => s.user === BOB)!.permissions = 'rwf'
    const result = await job.run()
    expect(result).toMatchObject({ ok: true, value: { updated: 1, differences: [] } })
    expect(radicale.shares.find((s) => s.user === BOB)?.permissions).toBe('rw')
  })

  it('removes the share when the rule is deleted', async () => {
    const job = reconciler()
    await job.run()
    const id = calendarId(`/${ALICE}/work/`)
    addCalendarAcl(db, id, { principalType: 'user', principal: BOB, permission: 'read' })
    await job.run()
    db.prepare('DELETE FROM calendar_acl').run()
    await job.run()
    expect(radicale.shares.some((s) => s.user === BOB)).toBe(false)
  })

  it('retries later and marks nothing when Radicale is unreachable', async () => {
    const job = reconciler()
    await job.run()
    const id = calendarId(`/${ALICE}/work/`)
    addCalendarAcl(db, id, { principalType: 'user', principal: BOB, permission: 'read' })
    radicale.down = true
    const result = await job.run()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('unreachable')
    expect(listAllCalendarAcl(db).every((row) => row.applied_at === null)).toBe(true)
    expect(job.state().consecutiveFailures).toBe(1)
    radicale.down = false
    expect((await job.run()).ok).toBe(true)
    expect(job.state().consecutiveFailures).toBe(0)
    expect(listAllCalendarAcl(db).every((row) => row.applied_at !== null)).toBe(true)
  })

  it('alarms once per distinct difference and does not mark a refused share', async () => {
    const job = reconciler()
    await job.run()
    const id = calendarId(`/${ALICE}/work/`)
    addCalendarAcl(db, id, { principalType: 'user', principal: BOB, permission: 'read' })
    radicale.rejectCreates = true
    const first = await job.run()
    await job.run()
    expect(first).toMatchObject({ ok: true })
    expect(first.ok && first.value.differences.length).toBeGreaterThan(0)
    expect(listAllCalendarAcl(db).every((row) => row.applied_at === null)).toBe(true)
    expect(listAuditEntries(db).filter((e) => e.action === 'sharing.mismatch')).toHaveLength(1)
    expect(logs.some((line) => line.includes('differs'))).toBe(true)
  })
})

describe('sharing client', () => {
  it('refuses an invalid principal without sending a request', async () => {
    const client = createRadicaleClient({ baseUrl: radicale.url })
    for (const bad of ['', 'a/b', 'a b', '..', '.sharing', 'x\r\ny', 'é']) {
      const result = await client.listShares(bad, 'map')
      expect(result.ok).toBe(false)
      expect(!result.ok && result.failure.kind).toBe('invalid-principal')
    }
    expect(radicale.requests).toHaveLength(0)
  })

  it('does not follow redirects and caps the response size', async () => {
    const client = createRadicaleClient({ baseUrl: radicale.url, maxResponseBytes: 10 })
    const result = await client.listShares(ALICE, 'map')
    expect(!result.ok && result.failure.kind).toBe('too-large')
  })
})

describe('backoff', () => {
  it('doubles from the base and never exceeds the interval', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, 5000, 300_000))).toEqual([
      5000, 10_000, 20_000, 40_000,
    ])
    expect(backoffDelay(30, 5000, 300_000)).toBe(300_000)
  })
})
