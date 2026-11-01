import type { Database } from 'better-sqlite3'
import { isValidSubject } from '../utils/auth/subject'
import type { CalendarAclRow, Permission, PrincipalType } from './types'

// The access rules of a calendar (design §8). The sharing writer turns them into Radicale shares
// and calls markCalendarAclApplied once Radicale confirmed; `applied_at` is NULL until then.

export class AclError extends Error {
  constructor(
    readonly code: 'invalid_principal' | 'duplicate_rule',
    message: string,
  ) {
    super(message)
    this.name = 'AclError'
  }
}

/** A rule as the caller states it. `principal` is null exactly for authenticated and public. */
export interface CalendarAclInput {
  principalType: PrincipalType
  principal: string | null
  permission: Permission
}

/** Throws AclError unless a user or group principal is a valid identifier and the others have none. */
export function assertAclPrincipal(
  type: string,
  principal: string | null,
  catchAll: readonly string[],
): void {
  if (catchAll.includes(type)) {
    if (principal !== null) throw new AclError('invalid_principal', `${type} takes no principal`)
  } else if (!isValidSubject(principal)) {
    throw new AclError('invalid_principal', `The ${type} principal is not a valid identifier`)
  }
}

const CATCH_ALL = ['authenticated', 'public'] as const

function checked(rule: CalendarAclInput): CalendarAclInput {
  assertAclPrincipal(rule.principalType, rule.principal, CATCH_ALL)
  return rule
}

export function ruleKey(type: string, principal: string | null): string {
  return `${type}\u0000${principal ?? ''}`
}

/** The rules of one calendar, in the order they were added. */
export function listCalendarAcl(db: Database, calendarId: number): CalendarAclRow[] {
  return db
    .prepare<[number], CalendarAclRow>(
      'SELECT * FROM calendar_acl WHERE calendar_id = ? ORDER BY id',
    )
    .all(calendarId)
}

/** Every rule of every calendar, by calendar and then id. */
export function listAllCalendarAcl(db: Database): CalendarAclRow[] {
  return db.prepare<[], CalendarAclRow>('SELECT * FROM calendar_acl ORDER BY calendar_id, id').all()
}

/** The rules Radicale has not confirmed yet. */
export function listUnappliedCalendarAcl(db: Database): CalendarAclRow[] {
  return db
    .prepare<[], CalendarAclRow>('SELECT * FROM calendar_acl WHERE applied_at IS NULL ORDER BY id')
    .all()
}

/**
 * Makes the calendar's rule set exactly `rules` in one transaction. A rule that stays as it was
 * keeps its `applied_at`; a new rule, or one whose permission changed, is unapplied again.
 * Throws AclError for an invalid principal or two rules for the same principal.
 */
export function replaceCalendarAcl(
  db: Database,
  calendarId: number,
  rules: readonly CalendarAclInput[],
): CalendarAclRow[] {
  const wanted = new Map<string, CalendarAclInput>()
  for (const rule of rules) {
    checked(rule)
    const key = ruleKey(rule.principalType, rule.principal)
    if (wanted.has(key)) throw new AclError('duplicate_rule', 'Two rules name the same principal')
    wanted.set(key, rule)
  }
  const replace = db.transaction(() => {
    const existing = new Map(
      listCalendarAcl(db, calendarId).map((row) => [
        ruleKey(row.principal_type, row.principal),
        row,
      ]),
    )
    const remove = db.prepare('DELETE FROM calendar_acl WHERE id = ?')
    for (const [key, row] of existing) if (!wanted.has(key)) remove.run(row.id)
    const insert = db.prepare(
      'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
    )
    const change = db.prepare(
      'UPDATE calendar_acl SET permission = ?, applied_at = NULL WHERE id = ?',
    )
    for (const [key, rule] of wanted) {
      const row = existing.get(key)
      if (!row) insert.run(calendarId, rule.principalType, rule.principal, rule.permission)
      else if (row.permission !== rule.permission) change.run(rule.permission, row.id)
    }
    return listCalendarAcl(db, calendarId)
  })
  return replace.immediate()
}

/** Adds a rule, or changes the permission of the existing rule for that principal. */
export function addCalendarAcl(
  db: Database,
  calendarId: number,
  rule: CalendarAclInput,
): CalendarAclRow {
  checked(rule)
  const add = db.transaction(() => {
    const existing = db
      .prepare<[number, string, string], CalendarAclRow>(
        `SELECT * FROM calendar_acl
         WHERE calendar_id = ? AND principal_type = ? AND COALESCE(principal, '') = ?`,
      )
      .get(calendarId, rule.principalType, rule.principal ?? '')
    if (!existing) {
      return db
        .prepare<[number, string, string | null, string], CalendarAclRow>(
          `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
           VALUES (?, ?, ?, ?) RETURNING *`,
        )
        .get(calendarId, rule.principalType, rule.principal, rule.permission)!
    }
    if (existing.permission === rule.permission) return existing
    return db
      .prepare<[string, number], CalendarAclRow>(
        'UPDATE calendar_acl SET permission = ?, applied_at = NULL WHERE id = ? RETURNING *',
      )
      .get(rule.permission, existing.id)!
  })
  return add.immediate()
}

/** Removes the rule of one principal. False when there was none. */
export function removeCalendarAcl(
  db: Database,
  calendarId: number,
  principalType: PrincipalType,
  principal: string | null,
): boolean {
  return (
    db
      .prepare(
        `DELETE FROM calendar_acl
         WHERE calendar_id = ? AND principal_type = ? AND COALESCE(principal, '') = ?`,
      )
      .run(calendarId, principalType, principal ?? '').changes > 0
  )
}

/** Records that Radicale confirmed these rules. Returns how many rows changed. */
export function markCalendarAclApplied(
  db: Database,
  ids: readonly number[],
  appliedAt: Date = new Date(),
): number {
  const stamp = appliedAt.toISOString()
  const mark = db.prepare('UPDATE calendar_acl SET applied_at = ? WHERE id = ?')
  return db.transaction(() => ids.reduce((sum, id) => sum + mark.run(stamp, id).changes, 0))()
}
