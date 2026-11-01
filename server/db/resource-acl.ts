import type { Database } from 'better-sqlite3'
import { AclError, assertAclPrincipal, ruleKey } from './calendar-acl'
import type { ResourceAclPrincipalType, ResourceAclRow, ResourceRight } from './types'

// Who may read, book and manage a resource. manage includes book includes read.

export interface ResourceAclInput {
  principalType: ResourceAclPrincipalType
  principal: string | null
  right: ResourceRight
}

const RANK: Record<ResourceRight, number> = { read: 1, book: 2, manage: 3 }

function checked(rule: ResourceAclInput): ResourceAclInput {
  assertAclPrincipal(rule.principalType, rule.principal, ['authenticated'])
  return rule
}

export function listResourceAcl(db: Database, resourceId: number): ResourceAclRow[] {
  return db
    .prepare<[number], ResourceAclRow>(
      'SELECT * FROM resource_acl WHERE resource_id = ? ORDER BY id',
    )
    .all(resourceId)
}

/** Makes the rule set exactly `rules` in one transaction. Throws AclError for bad input. */
export function replaceResourceAcl(
  db: Database,
  resourceId: number,
  rules: readonly ResourceAclInput[],
): ResourceAclRow[] {
  const wanted = new Map<string, ResourceAclInput>()
  for (const rule of rules) {
    checked(rule)
    const key = ruleKey(rule.principalType, rule.principal)
    if (wanted.has(key)) throw new AclError('duplicate_rule', 'Two rules name the same principal')
    wanted.set(key, rule)
  }
  const replace = db.transaction(() => {
    const existing = new Map(
      listResourceAcl(db, resourceId).map((row) => [
        ruleKey(row.principal_type, row.principal),
        row,
      ]),
    )
    const remove = db.prepare('DELETE FROM resource_acl WHERE id = ?')
    for (const [key, row] of existing) if (!wanted.has(key)) remove.run(row.id)
    const insert = db.prepare(
      'INSERT INTO resource_acl (resource_id, principal_type, principal, "right") VALUES (?, ?, ?, ?)',
    )
    const change = db.prepare('UPDATE resource_acl SET "right" = ? WHERE id = ?')
    for (const [key, rule] of wanted) {
      const row = existing.get(key)
      if (!row) insert.run(resourceId, rule.principalType, rule.principal, rule.right)
      else if (row.right !== rule.right) change.run(rule.right, row.id)
    }
    return listResourceAcl(db, resourceId)
  })
  return replace.immediate()
}

/** Adds a rule, or changes the right of the existing rule for that principal. */
export function addResourceAcl(
  db: Database,
  resourceId: number,
  rule: ResourceAclInput,
): ResourceAclRow {
  checked(rule)
  const add = db.transaction(() => {
    const existing = db
      .prepare<[number, string, string], ResourceAclRow>(
        `SELECT * FROM resource_acl
         WHERE resource_id = ? AND principal_type = ? AND COALESCE(principal, '') = ?`,
      )
      .get(resourceId, rule.principalType, rule.principal ?? '')
    if (!existing) {
      return db
        .prepare<[number, string, string | null, string], ResourceAclRow>(
          `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
           VALUES (?, ?, ?, ?) RETURNING *`,
        )
        .get(resourceId, rule.principalType, rule.principal, rule.right)!
    }
    if (existing.right === rule.right) return existing
    return db
      .prepare<[string, number], ResourceAclRow>(
        'UPDATE resource_acl SET "right" = ? WHERE id = ? RETURNING *',
      )
      .get(rule.right, existing.id)!
  })
  return add.immediate()
}

/** Removes the rule of one principal. False when there was none. */
export function removeResourceAcl(
  db: Database,
  resourceId: number,
  principalType: ResourceAclPrincipalType,
  principal: string | null,
): boolean {
  return (
    db
      .prepare(
        `DELETE FROM resource_acl
         WHERE resource_id = ? AND principal_type = ? AND COALESCE(principal, '') = ?`,
      )
      .run(resourceId, principalType, principal ?? '').changes > 0
  )
}

/** The highest right the user has, from their own rule, their groups' and `authenticated`. */
export function effectiveResourceRight(
  db: Database,
  resourceId: number,
  user: { sub: string; groups: readonly string[] },
): ResourceRight | null {
  let best: ResourceRight | null = null
  for (const row of listResourceAcl(db, resourceId)) {
    const applies =
      row.principal_type === 'authenticated' ||
      (row.principal_type === 'user' && row.principal === user.sub) ||
      (row.principal_type === 'group' && user.groups.includes(row.principal ?? ''))
    if (applies && (best === null || RANK[row.right] > RANK[best])) best = row.right
  }
  return best
}
