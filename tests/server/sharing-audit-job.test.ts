// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { addCalendarAcl } from '../../server/db/calendar-acl'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { createConsistencyAudit } from '../../server/utils/sharing/audit-job'
import { parseGroupFile, type GroupMembership } from '../../server/utils/sharing/membership'
import { createRadicaleClient } from '../../server/utils/sharing/radicale-client'
import { createSharingReconciler } from '../../server/utils/sharing/reconcile'
import { startFakeRadicale, type FakeRadicale } from './sharing-fake-radicale'

const ALICE = '8f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77'
const BOB = '3d9a7e51-0c2b-4f86-b1aa-6e4d8c0f9a12'

let db: Database
let radicale: FakeRadicale
const logs: string[] = []
const log = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }

const members = parseGroupFile(`web_calendar_users: ${ALICE} ${BOB}\n`)
const membership: GroupMembership = {
  groupsOf: async (sub) => members.get(sub) ?? new Set<string>(),
  all: async () => members,
}

beforeEach(async () => {
  db = openDatabase(':memory:')
  runMigrations(
    db,
    loadMigrationsFromDir(fileURLToPath(new URL('../../server/db/migrations', import.meta.url))),
  )
  db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)').run(ALICE, 'alice')
  db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)').run(BOB, 'bob')
  radicale = await startFakeRadicale()
  radicale.calendars.set(ALICE, new Set(['work']))
  radicale.groups.set('web_calendar_users', new Set([ALICE, BOB]))
  logs.length = 0
})

afterEach(async () => {
  db.close()
  await radicale.close()
})

async function applied() {
  const client = createRadicaleClient({ baseUrl: radicale.url })
  const reconciler = createSharingReconciler({ db, client, log })
  await reconciler.run()
  const id = (db.prepare('SELECT id FROM calendars').get() as { id: number }).id
  addCalendarAcl(db, id, { principalType: 'user', principal: BOB, permission: 'read' })
  await reconciler.run()
  return { client, id }
}

describe('nightly consistency audit', () => {
  it('finds nothing when every home matches the rules', async () => {
    const { client } = await applied()
    const result = await createConsistencyAudit({ db, client, membership, log }).run()
    expect(result).toEqual({ ok: true, value: { usersChecked: 2, differences: [] } })
  })

  it('reports a share a user sees without a rule, and audits it once', async () => {
    const { client } = await applied()
    radicale.shares.push({
      owner: ALICE,
      pathMapped: `/${ALICE}/work/`,
      pathOrToken: `/${ALICE}/shared-99/`,
      user: ALICE,
      permissions: 'rw',
      enabled: true,
      hidden: false,
      accepted: true,
    })
    const job = createConsistencyAudit({ db, client, membership, log })
    const result = await job.run()
    expect(result.ok && result.value.differences).toEqual([
      `${ALICE} sees shared-99 without a rule`,
    ])
    await job.run()
    expect(listAuditEntries(db).filter((e) => e.action === 'sharing.audit_mismatch')).toHaveLength(
      1,
    )
    expect(logs.some((line) => line.includes('consistency audit'))).toBe(true)
  })

  it('reports a confirmed rule whose share the member does not see', async () => {
    const { client, id } = await applied()
    radicale.shares = radicale.shares.filter((share) => share.user !== BOB)
    const result = await createConsistencyAudit({ db, client, membership, log }).run()
    expect(result.ok && result.value.differences).toEqual([`${BOB} lacks shared-${id}`])
  })
})
