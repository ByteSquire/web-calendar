// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { createAppToken, verifyAppToken } from '../../server/db/app-tokens'
import { upsertUser } from '../../server/db/users'
import {
  createAppPorts,
  listAclGroupNames,
  revokeTokensOfNonMembers,
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

describe('revoking the app tokens of users who left the users group (security review 2026-11-01)', () => {
  const KEY = 'test-hash-key'
  const SUB_ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
  const SUB_BOB = '6f9f0e2d-0000-4000-8000-000000000002'
  const SUB_CAROL = '6f9f0e2d-0000-4000-8000-000000000003'
  const LONG_AGO = new Date('2026-10-01T00:00:00.000Z')
  const RUN_START = new Date('2026-11-01T12:00:00.000Z')

  function user(sub: string, username: string) {
    return upsertUser(db, { sub, username }, LONG_AGO)
  }
  /** The database stamps `created_at` itself, with the real clock; the tests set it by hand. */
  function token(userId: number, label = 'phone', at = LONG_AGO) {
    const made = createAppToken(db, KEY, userId, label, at)
    db.prepare('UPDATE app_tokens SET created_at = ? WHERE id = ?').run(at.toISOString(), made.id)
    return made
  }
  const count = (userId: number) =>
    Number(db.prepare('SELECT COUNT(*) AS n FROM app_tokens WHERE user_id = ?').pluck().get(userId))

  it('deletes every token of a user who is not a member, so the token stops working', () => {
    const alice = user(SUB_ALICE, 'alice@idm.example.org')
    const bob = user(SUB_BOB, 'bob@idm.example.org')
    token(alice.id)
    token(alice.id, 'laptop')
    const bobsToken = token(bob.id)

    const gone = revokeTokensOfNonMembers(db, new Set([SUB_ALICE]), RUN_START)

    expect(gone).toEqual([{ username: 'bob@idm.example.org', revoked: 1 }])
    expect(count(bob.id)).toBe(0)
    expect(count(alice.id)).toBe(2)
    expect(verifyAppToken(db, KEY, 'bob@idm.example.org', bobsToken.token, RUN_START)).toBeNull()
  })

  it('does not touch a token made after the run began (a user added meanwhile)', () => {
    const carol = user(SUB_CAROL, 'carol@idm.example.org')
    token(carol.id, 'old')
    token(carol.id, 'new', new Date(RUN_START.getTime() + 1000))
    expect(revokeTokensOfNonMembers(db, new Set(), RUN_START)).toEqual([
      { username: 'carol@idm.example.org', revoked: 1 },
    ])
    expect(count(carol.id)).toBe(1)
  })

  it('does nothing, and writes nothing, when everybody who has tokens is a member', () => {
    const alice = user(SUB_ALICE, 'alice@idm.example.org')
    token(alice.id)
    user(SUB_BOB, 'bob@idm.example.org') // no tokens at all
    expect(revokeTokensOfNonMembers(db, new Set([SUB_ALICE]), RUN_START)).toEqual([])
    expect(count(alice.id)).toBe(1)
  })

  it('matches on the sub, not on the user name', () => {
    const alice = user(SUB_ALICE, 'alice@idm.example.org')
    token(alice.id)
    expect(revokeTokensOfNonMembers(db, new Set(['alice@idm.example.org']), RUN_START)).toEqual([
      { username: 'alice@idm.example.org', revoked: 1 },
    ])
  })

  it('the app port audits each removed user as the system actor, without the word "token" as a key', () => {
    const alice = user(SUB_ALICE, 'alice@idm.example.org')
    const bob = user(SUB_BOB, 'bob@idm.example.org')
    token(alice.id)
    token(bob.id)
    token(bob.id, 'laptop')

    const ports = createAppPorts(() => db, log())
    expect(ports.revokeTokensOfNonMembers!(new Set([SUB_ALICE]), RUN_START)).toEqual({
      users: 1,
      revoked: 2,
    })

    const [entry] = listAuditEntries(db, {})
    expect(entry).toMatchObject({
      actor_sub: SYSTEM_ACTOR,
      action: 'group_sync.tokens_revoked',
      target: 'bob@idm.example.org',
    })
    // The audit log redacts any key that looks like a secret: the count must survive that.
    expect(JSON.parse(entry?.details ?? 'null')).toEqual({
      revoked: 2,
      reason: 'no longer in the users group',
    })
  })

  it('the app port audits nothing when nobody lost a token', () => {
    const alice = user(SUB_ALICE, 'alice@idm.example.org')
    token(alice.id)
    const ports = createAppPorts(() => db, log())
    expect(ports.revokeTokensOfNonMembers!(new Set([SUB_ALICE]), RUN_START)).toEqual({
      users: 0,
      revoked: 0,
    })
    expect(listAuditEntries(db, {})).toEqual([])
  })
})
