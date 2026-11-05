// @vitest-environment node
// The import of a person's groups at sign-in (real SQLite): candidates, membership of the groups an
// admin imported, renames, pruning, and the promise that a sign-in that changes nothing writes nothing.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCalendarAcl, listCalendarAcl } from '../../server/db/calendar-acl'
import { parseGroupsClaim, type ParsedClaim } from '../../server/utils/groups/claim'
import {
  IMPORT_ACTOR,
  PRUNE_AFTER_MS,
  importUserGroups,
  resetImportState,
} from '../../server/utils/groups/import'
import { openTestDb } from './api-fixtures'

const ALICE = 'alice-sub'
const BOB = 'Bob-Sub'
const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-06-01T10:00:00.000Z')
const OPTIONS = { adminGroup: 'calendar_admins' }

let db: Database

beforeEach(() => {
  db = openTestDb()
  resetImportState()
})
afterEach(() => db.close())

const claim = (...entries: string[]): ParsedClaim => parseGroupsClaim(entries, { ignore: [] })
/** A claim whose one group has a name unlike its key (what a rename at the provider looks like). */
const named = (key: string, name: string): ParsedClaim => ({
  absent: false,
  groups: [{ key, name }],
  warnings: [],
})
const run = (sub: string, parsed: ParsedClaim, at = T0) =>
  importUserGroups(db, sub, parsed, at, OPTIONS)

/** An imported group, as an admin's Import makes it. */
function importGroup(name: string, externalId = name): number {
  return db
    .prepare(`INSERT INTO groups (name, source, external_id) VALUES (?, 'oidc', ?) RETURNING id`)
    .pluck()
    .get(name, externalId) as number
}
const membersOf = (groupId: number): string[] =>
  db
    .prepare<[number], string>('SELECT sub FROM group_members WHERE group_id = ? ORDER BY sub')
    .pluck()
    .all(groupId)
const candidates = () =>
  db.prepare('SELECT external_id AS id, name, conflict FROM oidc_group_candidates ORDER BY 1').all()
const audits = () =>
  db.prepare<[], { actor_sub: string; action: string; target: string; details: string }>(
    `SELECT actor_sub, action, target, details FROM audit_log ORDER BY id`,
  )
const changes = () => db.prepare('SELECT total_changes()').pluck().get() as number

describe('candidates', () => {
  it('remembers every group of the claim, and grants nothing', () => {
    const outcome = run(ALICE, claim('staff', '/team/ops', 'ops@idm.example.org'))
    expect(candidates()).toEqual([
      { id: '/team/ops', name: 'team.ops', conflict: 0 },
      { id: 'ops@idm.example.org', name: 'ops', conflict: 0 },
      { id: 'staff', name: 'staff', conflict: 0 },
    ])
    expect(db.prepare('SELECT COUNT(*) FROM group_members').pluck().get()).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) FROM groups WHERE source = 'oidc'`).pluck().get()).toBe(0)
    expect(outcome).toMatchObject({ membershipsChanged: false, joined: 0, left: 0, renamed: 0 })
    // New candidates are not an event for the audit log.
    expect(audits().all()).toEqual([])
  })

  it('flags both keys that share a name, and unflags them when the provider renames one', () => {
    const one = '3315c15e-4ff7-459a-97de-d176279d4154'
    const two = 'a12fec6b-b6d8-4973-8b6f-42dd669f9aca'
    run(ALICE, claim(one, 'staff', two, 'Staff'))
    const flags = () => candidates().map((c) => (c as { conflict: number }).conflict)
    expect(flags()).toEqual([1, 1])
    // The second group is renamed at the provider: no name is shared any more.
    run(BOB, claim(two, 'staff2'))
    expect(candidates()).toEqual([
      { id: one, name: 'staff', conflict: 0 },
      { id: two, name: 'staff2', conflict: 0 },
    ])
  })

  it('writes the name a key has now, and a conflict with a third key later', () => {
    run(ALICE, claim('a'))
    run(BOB, claim('b'))
    run(ALICE, claim('B@x'), new Date(T0.getTime() + 1))
    // 'b' and 'B@x' are both named b/B: names are compared without regard to case.
    expect(candidates().filter((c) => (c as { conflict: number }).conflict === 1)).toHaveLength(2)
  })
})

describe('membership of imported groups', () => {
  it('joins an imported group the claim names, and only that one', () => {
    const staff = importGroup('staff')
    const ops = importGroup('ops')
    const outcome = run(ALICE, claim('staff', 'other'))
    expect(membersOf(staff)).toEqual([ALICE])
    expect(membersOf(ops)).toEqual([])
    expect(outcome).toMatchObject({ membershipsChanged: true, joined: 1, left: 0 })
  })

  it('removes the person from a group the claim no longer names, and moves between groups', () => {
    const staff = importGroup('staff')
    const ops = importGroup('ops')
    run(ALICE, claim('staff'))
    const outcome = run(ALICE, claim('ops'), new Date(T0.getTime() + 1000))
    expect(membersOf(staff)).toEqual([])
    expect(membersOf(ops)).toEqual([ALICE])
    expect(outcome).toMatchObject({ joined: 1, left: 1 })
  })

  it('leaves other people, app groups and the group of everyone alone', () => {
    const staff = importGroup('staff')
    db.prepare(`INSERT INTO groups (name, source) VALUES ('mine', 'app')`).run()
    const mine = db.prepare(`SELECT id FROM groups WHERE name = 'mine'`).pluck().get() as number
    const everyone = db
      .prepare(`SELECT id FROM groups WHERE source = 'everyone'`)
      .pluck()
      .get() as number
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?), (?, ?)').run(
      staff,
      BOB,
      mine,
      ALICE,
    )
    // The claim names a group called "mine" too: it is a candidate, not the app group's members.
    run(ALICE, claim('staff', 'mine'))
    expect(membersOf(staff)).toEqual([BOB, ALICE])
    expect(membersOf(mine)).toEqual([ALICE])
    expect(membersOf(everyone)).toEqual([])
    run(ALICE, claim())
    expect(membersOf(staff)).toEqual([BOB])
    expect(membersOf(mine)).toEqual([ALICE])
  })

  it('removes the person from every imported group on an empty claim, and not on an absent one', () => {
    const staff = importGroup('staff')
    run(ALICE, claim('staff'))
    expect(run(ALICE, { absent: true }, new Date(T0.getTime() + 1000))).toMatchObject({
      membershipsChanged: false,
    })
    expect(membersOf(staff)).toEqual([ALICE])
    expect(run(ALICE, claim(), new Date(T0.getTime() + 2000))).toMatchObject({ left: 1 })
    expect(membersOf(staff)).toEqual([])
  })

  it('matches the group by the provider key, not by the name', () => {
    const staff = importGroup('staff', '3315c15e-4ff7-459a-97de-d176279d4154')
    // A group that merely has the same name but another key is not the imported one.
    run(ALICE, claim('staff'))
    expect(membersOf(staff)).toEqual([])
    run(ALICE, claim('3315c15e-4ff7-459a-97de-d176279d4154', 'staff@idm.example.org'))
    expect(membersOf(staff)).toEqual([ALICE])
  })

  it('keeps the sub as it is sent: another case is another person', () => {
    const staff = importGroup('staff')
    run('Bob-Sub', claim('staff'))
    run('bob-sub', claim())
    expect(membersOf(staff)).toEqual(['Bob-Sub'])
  })

  it('imports a claim of 200 groups', () => {
    for (let i = 0; i < 200; i += 1) importGroup(`g${i}`)
    const parsed = claim(...Array.from({ length: 200 }, (_, i) => `g${i}`))
    expect(run(ALICE, parsed).joined).toBe(200)
    expect(candidates()).toHaveLength(200)
  })
})

describe('a claim that was cut at the cap', () => {
  it('adds the person to groups it shows, and takes them out of none it does not show', () => {
    const kept = importGroup('kept')
    const shown = importGroup('shown')
    run(ALICE, claim('kept'))
    expect(membersOf(kept)).toEqual([ALICE])
    const cut: ParsedClaim = { ...claim('shown'), truncated: true } as ParsedClaim
    const outcome = run(ALICE, cut, new Date(T0.getTime() + 1000))
    expect(membersOf(shown)).toEqual([ALICE])
    expect(membersOf(kept)).toEqual([ALICE])
    expect(outcome).toMatchObject({ joined: 1, left: 0 })
    // The same claim whole would have removed them from `kept`.
    run(ALICE, claim('shown'), new Date(T0.getTime() + 2000))
    expect(membersOf(kept)).toEqual([])
  })
})

describe('a sign-in that changes nothing writes nothing', () => {
  it('does not write a row the second time, and not one day later either', () => {
    importGroup('staff')
    const parsed = claim('staff', 'other')
    run(ALICE, parsed)
    const before = changes()
    const auditRows = audits().all().length
    const outcome = run(ALICE, parsed, new Date(T0.getTime() + 60_000))
    run(ALICE, parsed, new Date(T0.getTime() + 23 * 60 * 60 * 1000))
    expect(changes()).toBe(before)
    expect(audits().all()).toHaveLength(auditRows)
    expect(outcome).toMatchObject({ membershipsChanged: false, renamed: 0 })
  })

  it('touches the last-seen time of a candidate once a day', () => {
    run(ALICE, claim('staff'))
    const seen = () =>
      db.prepare('SELECT last_seen_at FROM oidc_group_candidates').pluck().get() as string
    expect(seen()).toBe(T0.toISOString())
    run(ALICE, claim('staff'), new Date(T0.getTime() + DAY - 1))
    expect(seen()).toBe(T0.toISOString())
    run(ALICE, claim('staff'), new Date(T0.getTime() + DAY))
    expect(seen()).toBe(new Date(T0.getTime() + DAY).toISOString())
  })

  it('writes nothing when an absent claim comes', () => {
    const before = changes()
    run(ALICE, { absent: true })
    expect(changes()).toBe(before)
  })
})

describe('renames at the provider', () => {
  function seedRules(groupName: string) {
    const calendar = Number(
      db
        .prepare(
          `INSERT INTO calendars (name, kind, collection_path) VALUES ('c', 'shared', '/x/c/')`,
        )
        .run().lastInsertRowid,
    )
    addCalendarAcl(db, calendar, {
      principalType: 'group',
      principal: groupName,
      permission: 'read',
    })
    db.prepare(`INSERT INTO resources (name, type) VALUES ('Room', 'room')`).run()
    db.prepare(
      `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
       VALUES ((SELECT id FROM resources LIMIT 1), 'group', ?, 'read')`,
    ).run(groupName)
    return calendar
  }

  it('renames the group and the rules that name it', () => {
    const id = importGroup('staff', '3315c15e-4ff7-459a-97de-d176279d4154')
    const calendar = seedRules('staff')
    const outcome = run(
      ALICE,
      claim('3315c15e-4ff7-459a-97de-d176279d4154', 'employees@idm.example.org'),
    )
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').pluck().get(id)).toBe('employees')
    expect(listCalendarAcl(db, calendar).map((r) => r.principal)).toEqual(['employees'])
    expect(db.prepare('SELECT principal FROM resource_acl').pluck().all()).toEqual(['employees'])
    expect(outcome).toMatchObject({ renamed: 1 })
    expect(JSON.parse(audits().get()!.details).renamed).toEqual([
      { from: 'staff', to: 'employees' },
    ])
  })

  it('keeps the old name when the new one is taken, or reserved, and says so once', () => {
    importGroup('staff', 'k1')
    db.prepare(`INSERT INTO groups (name, source) VALUES ('Taken', 'app')`).run()
    seedRules('staff')
    // The provider renamed k1 to Taken, then to the admin group, then to the users group.
    for (const name of ['taken', 'calendar_admins', 'web_calendar_users']) {
      const outcome = run(ALICE, named('k1', name))
      expect(outcome.renamed).toBe(0)
      expect(outcome.warnings).toEqual([expect.stringContaining(`to "${name}"`)])
      // The same refusal again is not said again, and writes nothing.
      const before = changes()
      const again = run(ALICE, named('k1', name))
      expect(again.warnings).toEqual([])
      expect(changes()).toBe(before)
    }
    expect(db.prepare(`SELECT name FROM groups WHERE external_id = 'k1'`).pluck().get()).toBe(
      'staff',
    )
    expect(db.prepare(`SELECT principal FROM resource_acl`).pluck().all()).toEqual(['staff'])
  })

  it('renames a group to its own name in another case', () => {
    importGroup('staff', 'k1')
    expect(run(ALICE, named('k1', 'Staff')).renamed).toBe(1)
    expect(db.prepare(`SELECT name FROM groups WHERE external_id = 'k1'`).pluck().get()).toBe(
      'Staff',
    )
  })
})

describe('forgetting candidates', () => {
  it('removes those not seen for 90 days, never those of an imported group, once a day', () => {
    run(ALICE, claim('old', 'kept-import', 'recent'))
    importGroup('kept-import', 'kept-import')
    db.prepare(
      `UPDATE oidc_group_candidates SET last_seen_at = ? WHERE external_id IN ('old', 'kept-import')`,
    ).run(new Date(T0.getTime() - PRUNE_AFTER_MS - 1).toISOString())
    // Within the day of the first run nothing is pruned.
    run(BOB, claim('trigger'), new Date(T0.getTime() + 60_000))
    expect(candidates().map((c) => (c as { id: string }).id)).toContain('old')
    run(BOB, claim('trigger'), new Date(T0.getTime() + DAY + 60_000))
    expect(candidates().map((c) => (c as { id: string }).id)).toEqual([
      'kept-import',
      'recent',
      'trigger',
    ])
  })
})

describe('the audit entry', () => {
  it('has one entry per change, with names and counts and no member lists', () => {
    const staff = importGroup('staff')
    importGroup('ops')
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(staff, BOB)
    run(ALICE, claim('staff', 'ops'))
    const [entry, ...rest] = audits().all()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ actor_sub: IMPORT_ACTOR, action: 'groups.import', target: ALICE })
    const details = JSON.parse(entry!.details)
    expect(details.joined.sort()).toEqual(['ops', 'staff'])
    expect(details.counts).toEqual({ joined: 2, left: 0, renamed: 0 })
    expect(entry!.details).not.toContain(BOB)
  })

  it('rolls everything back when the entry cannot be written', () => {
    const staff = importGroup('staff')
    db.exec(
      `CREATE TRIGGER no_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'no'); END`,
    )
    expect(() => run(ALICE, claim('staff', 'new-candidate'))).toThrow()
    expect(membersOf(staff)).toEqual([])
    expect(candidates()).toEqual([])
  })
})

describe('renames that the checks could not foresee', () => {
  const resourceRule = (name: string) => {
    db.prepare(`INSERT OR IGNORE INTO resources (id, name, type) VALUES (1, 'Room', 'room')`).run()
    db.prepare(
      `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
       VALUES (1, 'group', ?, 'read')`,
    ).run(name)
  }

  it('does not rename onto a name that rules without a group already use, and still applies the leaves', () => {
    const ops = importGroup('ops', 'k-ops')
    const other = importGroup('other', 'k-other')
    resourceRule('ops')
    resourceRule('finance')
    run(ALICE, {
      absent: false,
      groups: [
        { key: 'k-ops', name: 'ops' },
        { key: 'k-other', name: 'other' },
      ],
      warnings: [],
    })
    expect(membersOf(ops)).toEqual([ALICE])
    expect(membersOf(other)).toEqual([ALICE])
    // The provider renames k-ops to "finance" (a name only a rule has) and alice left "other".
    const outcome = run(ALICE, {
      absent: false,
      groups: [{ key: 'k-ops', name: 'finance' }],
      warnings: [],
    })
    expect(outcome.renamed).toBe(0)
    expect(outcome.warnings).toEqual([expect.stringContaining('taken or reserved')])
    expect(db.prepare(`SELECT name FROM groups WHERE id = ?`).pluck().get(ops)).toBe('ops')
    expect(db.prepare('SELECT principal FROM resource_acl ORDER BY id').pluck().all()).toEqual([
      'ops',
      'finance',
    ])
    expect(membersOf(other)).toEqual([])
  })

  it('lets only the first of two renames to one name through, in the same claim', () => {
    const a = importGroup('team_a', 'k-a')
    const b = importGroup('team_b', 'k-b')
    const outcome = run(ALICE, {
      absent: false,
      groups: [
        { key: 'k-a', name: 'team_3' },
        { key: 'k-b', name: 'Team_3' },
      ],
      warnings: [],
    })
    expect(outcome.renamed).toBe(1)
    expect(membersOf(a)).toEqual([ALICE])
    expect(membersOf(b)).toEqual([ALICE])
    expect(db.prepare(`SELECT name FROM groups ORDER BY id`).pluck().all()).toContain('team_3')
  })

  it('keeps the joins and leaves when a rename fails inside the transaction', () => {
    const ops = importGroup('ops', 'k-ops')
    const other = importGroup('other', 'k-other')
    run(ALICE, claim('k-other'))
    // A trigger the checks cannot see makes the rename itself fail.
    db.exec(
      `CREATE TRIGGER no_rename BEFORE UPDATE OF name ON groups
       BEGIN SELECT RAISE(ABORT, 'no rename'); END`,
    )
    const outcome = run(ALICE, {
      absent: false,
      groups: [{ key: 'k-ops', name: 'renamed' }],
      warnings: [],
    })
    expect(outcome.warnings).toEqual([expect.stringContaining('could not be renamed')])
    expect(membersOf(ops)).toEqual([ALICE])
    expect(membersOf(other)).toEqual([])
    expect(outcome).toMatchObject({ joined: 1, left: 1, renamed: 0 })
  })
})
