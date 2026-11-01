// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import {
  createAppPorts,
  listAclGroupNames,
  SYSTEM_ACTOR,
} from '../../server/utils/group-sync/app-ports'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
})

afterEach(() => {
  db.close()
})

function addCalendar(path: string): number {
  return Number(
    db
      .prepare("INSERT INTO calendars (name, kind, collection_path) VALUES ('T', 'shared', ?)")
      .run(path).lastInsertRowid,
  )
}

function groupRule(calendarId: number, group: string): void {
  db.prepare(
    "INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, 'group', ?, 'read')",
  ).run(calendarId, group)
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('listAclGroupNames', () => {
  it('lists the groups of calendar and resource rules once each, sorted', () => {
    const first = addCalendar('/a/')
    const second = addCalendar('/b/')
    groupRule(first, 'sales')
    groupRule(second, 'sales')
    groupRule(second, 'design')
    db.prepare("INSERT INTO resources (name, type) VALUES ('Room', 'room')").run()
    db.prepare(
      `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
       VALUES (1, 'group', 'facilities', 'manage')`,
    ).run()
    expect(listAclGroupNames(db, log())).toEqual(['design', 'facilities', 'sales'])
  })

  it('ignores users and catch-all rules', () => {
    const calendar = addCalendar('/a/')
    db.prepare(
      `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
       VALUES (?, 'authenticated', NULL, 'free_busy')`,
    ).run(calendar)
    expect(listAclGroupNames(db, log())).toEqual([])
  })

  it('leaves out a name the sync cannot read and warns, so one bad rule stops nobody', () => {
    const calendar = addCalendar('/a/')
    groupRule(calendar, 'sales')
    groupRule(calendar, 'ops@idm.example.org')
    const logger = log()
    expect(listAclGroupNames(db, logger)).toEqual(['sales'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toContain('ops@idm.example.org')
  })
})

describe('createAppPorts', () => {
  it('reads the extra groups from the access rules', async () => {
    groupRule(addCalendar('/a/'), 'sales')
    const ports = createAppPorts(() => db, log())
    expect(await ports.listExtraGroups()).toEqual(['sales'])
  })

  it('writes sync events to the audit log as the system actor', () => {
    const ports = createAppPorts(() => db, log())
    ports.audit({ action: 'group_sync.updated', details: { groups: ['sales'], members: 3 } })
    const [entry] = listAuditEntries(db, {})
    expect(entry).toMatchObject({ actor_sub: SYSTEM_ACTOR, action: 'group_sync.updated' })
    expect(JSON.parse(entry?.details ?? 'null')).toEqual({ groups: ['sales'], members: 3 })
  })

  it('does not throw when the audit entry cannot be written, and logs it', () => {
    const logger = log()
    const ports = createAppPorts(() => {
      throw new Error('database is not open')
    }, logger)
    expect(() => ports.audit({ action: 'group_sync.failing' })).not.toThrow()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toContain('group_sync.failing')
  })
})
