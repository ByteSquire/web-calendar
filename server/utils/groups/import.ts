// Groups from the identity provider, stored per person at each sign-in (or CalDAV sighting): the
// groups of the claim become candidates an admin may import, and the person's membership of the
// groups an admin already imported is made to match the claim. Nothing is stored for a group
// nobody imported, and the claim never creates a group. Without a change this writes nothing.
import type { Database } from 'better-sqlite3'
import { recordAudit } from '../../db/audit-log'
import { USERS_GROUP } from './config'
import type { ClaimGroup, ParsedClaim } from './claim'

export const IMPORT_ACTOR = 'system:group-import'

const DAY_MS = 24 * 60 * 60 * 1000
/** Candidates not seen for this long are forgotten (never those of an imported group). */
export const PRUNE_AFTER_MS = 90 * DAY_MS
/** The most group names one audit entry lists. */
const AUDIT_NAMES = 20

export interface ImportOptions {
  /** `oidc.adminGroup`: an imported group is never renamed onto it. */
  adminGroup: string
}

export interface ImportOutcome {
  /** Someone joined or left an imported group: the group file is stale. */
  membershipsChanged: boolean
  joined: number
  left: number
  /** Imported groups renamed after the provider renamed them: shares and the file are stale. */
  renamed: number
  /** Things worth a log line, each said once per run of the process. */
  warnings: string[]
}

const NOTHING: ImportOutcome = {
  membershipsChanged: false,
  joined: 0,
  left: 0,
  renamed: 0,
  warnings: [],
}

interface GroupRef {
  id: number
  name: string
  externalId: string
}

interface Plan {
  insertCandidates: ClaimGroup[]
  renameCandidates: { key: string; from: string; to: string }[]
  touchCandidates: string[]
  join: GroupRef[]
  leave: GroupRef[]
  rename: { group: GroupRef; to: string }[]
  prune: boolean
}

const isEmpty = (plan: Plan): boolean =>
  plan.insertCandidates.length === 0 &&
  plan.renameCandidates.length === 0 &&
  plan.touchCandidates.length === 0 &&
  plan.join.length === 0 &&
  plan.leave.length === 0 &&
  plan.rename.length === 0 &&
  !plan.prune

let lastPruneMs = 0
const said = new Set<string>()

/** For tests: forget when the last prune ran and which warnings were said. */
export function resetImportState(): void {
  lastPruneMs = 0
  said.clear()
}

function sayOnce(warnings: string[], message: string): void {
  if (said.has(message)) return
  if (said.size >= 1000) said.clear()
  said.add(message)
  warnings.push(message)
}

/**
 * Reads only: what has to change for `sub` to match the claim. A rename that cannot happen (the
 * name is taken or reserved) is left out and said once, so it does not make every sign-in a write.
 */
function plan(
  db: Database,
  sub: string,
  groups: readonly ClaimGroup[],
  now: Date,
  reserved: readonly string[],
  warnings: string[],
  /** The claim shows only part of the person's groups: nobody is taken out of a group. */
  partial: boolean,
): Plan {
  const candidate = db.prepare<[string], { name: string; last_seen_at: string }>(
    'SELECT name, last_seen_at FROM oidc_group_candidates WHERE external_id = ?',
  )
  const result: Plan = {
    insertCandidates: [],
    renameCandidates: [],
    touchCandidates: [],
    join: [],
    leave: [],
    rename: [],
    prune: now.getTime() - lastPruneMs >= DAY_MS,
  }
  for (const group of groups) {
    const row = candidate.get(group.key)
    if (!row) {
      result.insertCandidates.push(group)
      continue
    }
    if (row.name !== group.name) {
      result.renameCandidates.push({ key: group.key, from: row.name, to: group.name })
    }
    // Once a day at most: a sign-in that only repeats what is known writes nothing.
    const seen = Date.parse(row.last_seen_at)
    if (Number.isNaN(seen) || now.getTime() - seen >= DAY_MS) result.touchCandidates.push(group.key)
  }

  const keys = groups.map((group) => group.key)
  const byKey = new Map<string, GroupRef>()
  if (keys.length > 0) {
    const marks = keys.map(() => '?').join(',')
    for (const row of db
      .prepare<string[], { id: number; name: string; external_id: string }>(
        `SELECT id, name, external_id FROM groups
         WHERE source = 'oidc' AND external_id IN (${marks})`,
      )
      .all(...keys)) {
      byKey.set(row.external_id, { id: row.id, name: row.name, externalId: row.external_id })
    }
  }
  const member = new Set(
    db
      .prepare<[string], number>(
        `SELECT m.group_id FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE m.sub = ? AND g.source = 'oidc'`,
      )
      .pluck()
      .all(sub),
  )
  const wanted = new Set([...byKey.values()].map((group) => group.id))
  for (const group of byKey.values()) {
    if (!member.has(group.id)) result.join.push(group)
  }
  if (!partial && member.size > 0) {
    const names = db
      .prepare<[], { id: number; name: string; external_id: string }>(
        `SELECT id, name, external_id FROM groups WHERE source = 'oidc'`,
      )
      .all()
    for (const row of names) {
      if (member.has(row.id) && !wanted.has(row.id)) {
        result.leave.push({ id: row.id, name: row.name, externalId: row.external_id })
      }
    }
  }
  const taken = db.prepare<[string, number], { one: number }>(
    'SELECT 1 AS one FROM groups WHERE name = ? COLLATE NOCASE AND id <> ?',
  )
  // A rule can name a group that has no row (resource rules are only checked for their shape):
  // a rename onto such a name would hand those rules to the renamed group.
  const ruleNamed = db.prepare<[string, string], { one: number }>(
    `SELECT 1 AS one FROM calendar_acl WHERE principal_type = 'group' AND principal = ? COLLATE NOCASE
     UNION ALL
     SELECT 1 FROM resource_acl WHERE principal_type = 'group' AND principal = ? COLLATE NOCASE
     LIMIT 1`,
  )
  // Two groups renamed to one name in the same claim: the first takes it.
  const renamedTo = new Set<string>()
  for (const claim of groups) {
    const group = byKey.get(claim.key)
    if (!group || group.name === claim.name) continue
    const lower = claim.name.toLowerCase()
    if (
      reserved.includes(lower) ||
      renamedTo.has(lower) ||
      taken.get(claim.name, group.id) !== undefined ||
      (lower !== group.name.toLowerCase() && ruleNamed.get(claim.name, claim.name) !== undefined)
    ) {
      sayOnce(
        warnings,
        `[groups] the provider renamed the group "${group.name}" to "${claim.name}", which is taken or reserved here; it keeps its name`,
      )
      continue
    }
    renamedTo.add(lower)
    result.rename.push({ group, to: claim.name })
  }
  return result
}

/**
 * Makes the groups of `sub` match `parsed`, in one transaction, and returns what changed. An absent
 * claim changes nothing; an empty one removes the person from every imported group.
 *
 * - Candidates: every group of the claim is remembered (name, when it was last seen: at most one
 *   write a day per group). A name that two keys share marks both as `conflict`; neither can be
 *   imported until the provider changes one.
 * - Membership: in exactly the imported groups (`source = 'oidc'`) whose `external_id` is in the
 *   claim; other people's rows and groups of other sources are not touched.
 * - Rename: an imported group takes the name the claim now shows for its key, in its rules too
 *   (calendar and resource rules name groups). If that name is taken or reserved it keeps the old
 *   one and a warning says so.
 * - Candidates not seen for 90 days are removed, at most once a day.
 * One audit entry per change of memberships or names (names and counts, never member lists).
 */
export function importUserGroups(
  db: Database,
  sub: string,
  parsed: ParsedClaim,
  now: Date,
  options: ImportOptions,
): ImportOutcome {
  if (parsed.absent) return NOTHING
  const warnings: string[] = []
  for (const message of parsed.warnings) sayOnce(warnings, `[groups] ${message}`)

  const reserved = [options.adminGroup, USERS_GROUP].map((name) => name.toLowerCase())
  // The fast path reads only; the transaction plans again, because a request may have changed rows.
  if (isEmpty(plan(db, sub, parsed.groups, now, reserved, warnings, parsed.truncated === true))) {
    return { ...NOTHING, warnings }
  }
  const nowIso = now.toISOString()
  const outcome = { ...NOTHING, warnings }

  db.transaction(() => {
    const todo = plan(db, sub, parsed.groups, now, reserved, warnings, parsed.truncated === true)

    const touched = new Set<string>()
    const insert = db.prepare(
      `INSERT INTO oidc_group_candidates (external_id, name, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)`,
    )
    for (const group of todo.insertCandidates) {
      insert.run(group.key, group.name, nowIso, nowIso)
      touched.add(group.name.toLowerCase())
    }
    const renameCandidate = db.prepare(
      'UPDATE oidc_group_candidates SET name = ?, last_seen_at = ? WHERE external_id = ?',
    )
    for (const change of todo.renameCandidates) {
      renameCandidate.run(change.to, nowIso, change.key)
      touched.add(change.from.toLowerCase())
      touched.add(change.to.toLowerCase())
    }
    const touch = db.prepare(
      'UPDATE oidc_group_candidates SET last_seen_at = ? WHERE external_id = ?',
    )
    for (const key of todo.touchCandidates) touch.run(nowIso, key)
    // Two keys with one name are both flagged; with one left, the flag goes (also case-insensitively,
    // like the names of groups).
    const sameName = db.prepare<[string], { external_id: string; conflict: number }>(
      'SELECT external_id, conflict FROM oidc_group_candidates WHERE name = ? COLLATE NOCASE',
    )
    const flag = db.prepare('UPDATE oidc_group_candidates SET conflict = ? WHERE external_id = ?')
    for (const name of touched) {
      const rows = sameName.all(name)
      const wanted = rows.length > 1 ? 1 : 0
      for (const row of rows) if (row.conflict !== wanted) flag.run(wanted, row.external_id)
    }

    const addMember = db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)')
    for (const group of todo.join) addMember.run(group.id, sub)
    const dropMember = db.prepare('DELETE FROM group_members WHERE group_id = ? AND sub = ?')
    for (const group of todo.leave) dropMember.run(group.id, sub)

    const renamed: { from: string; to: string }[] = []
    for (const { group, to } of todo.rename) {
      // Each rename is its own savepoint: one that fails (a unique index the checks did not foresee)
      // is left out and said, and does not undo the joins and leaves of this person.
      try {
        db.transaction(() => {
          db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(to, group.id)
          db.prepare(
            `UPDATE calendar_acl SET principal = ? WHERE principal_type = 'group' AND principal = ?`,
          ).run(to, group.name)
          db.prepare(
            `UPDATE resource_acl SET principal = ? WHERE principal_type = 'group' AND principal = ?`,
          ).run(to, group.name)
        })()
        renamed.push({ from: group.name, to })
      } catch {
        sayOnce(
          warnings,
          `[groups] the group "${group.name}" could not be renamed to "${to}"; it keeps its name`,
        )
      }
    }

    if (todo.prune) {
      db.prepare(
        `DELETE FROM oidc_group_candidates WHERE last_seen_at < ?
         AND external_id NOT IN (SELECT external_id FROM groups WHERE source = 'oidc')`,
      ).run(new Date(now.getTime() - PRUNE_AFTER_MS).toISOString())
      lastPruneMs = now.getTime()
    }

    outcome.joined = todo.join.length
    outcome.left = todo.leave.length
    outcome.renamed = renamed.length
    outcome.membershipsChanged = todo.join.length + todo.leave.length > 0
    if (outcome.membershipsChanged || renamed.length > 0) {
      recordAudit(db, {
        actorSub: IMPORT_ACTOR,
        action: 'groups.import',
        target: sub,
        details: {
          joined: todo.join.slice(0, AUDIT_NAMES).map((group) => group.name),
          left: todo.leave.slice(0, AUDIT_NAMES).map((group) => group.name),
          renamed: renamed.slice(0, AUDIT_NAMES),
          counts: { joined: todo.join.length, left: todo.leave.length, renamed: renamed.length },
        },
      })
    }
  }).immediate()

  return outcome
}
