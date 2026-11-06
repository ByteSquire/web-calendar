// The access administration without HTTP: what the admin page lists and what a change does.
import type { Database } from 'better-sqlite3'
import { listCalendarAcl, replaceCalendarAcl, type CalendarAclInput } from '../../db/calendar-acl'
import type { CalendarAclRow, PrincipalType } from '../../db/types'
import { isDefaultCalendarPath } from '../../../shared/utils/default-calendar'

export interface AccessRuleView {
  id: number
  principalType: PrincipalType
  principal: string | null
  /** A name to show: the person's name, the group, or "Everyone signed in". */
  label: string
  permission: CalendarAclRow['permission']
  /** Radicale has confirmed the share (`applied_at` is set). */
  applied: boolean
  appliedAt: string | null
}

export interface AccessCalendarView {
  id: number
  name: string
  kind: 'personal' | 'shared' | 'resource'
  color: string | null
  /** The owner's name, or null for a calendar of the organization or a group. */
  owner: string | null
  /** The group that owns the calendar, or null. */
  group: { id: number; name: string } | null
  /** A person's default calendar: it cannot be deleted (shared/utils/default-calendar.ts). */
  isDefault: boolean
  /**
   * Where it is in Radicale (`/<owner>/<name>/`, decoded), so "Edit calendar" in the sidebar of
   * its owner can name it here; admins only see this view.
   */
  collectionPath: string
  rules: AccessRuleView[]
}

export interface AccessUserView {
  sub: string
  name: string | null
  username: string | null
}

interface CalendarRow {
  id: number
  name: string
  kind: AccessCalendarView['kind']
  color: string | null
  owner_name: string | null
  owner_username: string | null
  group_id: number | null
  group_name: string | null
  collection_path: string
}

const personLabel = (name: string | null, username: string | null, fallback: string) =>
  name || username || fallback

export function getCalendarRow(db: Database, id: number): CalendarRow | undefined {
  return db.prepare<[number], CalendarRow>(CALENDAR_SQL + ' WHERE c.id = ?').get(id)
}

const CALENDAR_SQL = `SELECT c.id, c.name, c.kind, c.color, u.name AS owner_name, u.username AS owner_username,
    c.group_id AS group_id, g.name AS group_name, c.collection_path AS collection_path
  FROM calendars c LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN groups g ON g.id = c.group_id`

function viewRules(db: Database, calendarId: number): AccessRuleView[] {
  const person = db.prepare<[string], { name: string | null; username: string | null }>(
    'SELECT name, username FROM users WHERE oidc_sub = ?',
  )
  return listCalendarAcl(db, calendarId).map((row) => {
    let label = 'Everyone signed in'
    if (row.principal_type === 'group') label = row.principal ?? ''
    else if (row.principal_type === 'user') {
      const found = person.get(row.principal ?? '')
      label = found ? personLabel(found.name, found.username, 'Unknown person') : 'Unknown person'
    } else if (row.principal_type === 'public') label = 'Public'
    return {
      id: row.id,
      principalType: row.principal_type,
      principal: row.principal,
      label,
      permission: row.permission,
      applied: row.applied_at !== null,
      appliedAt: row.applied_at,
    }
  })
}

function toCalendarView(db: Database, row: CalendarRow): AccessCalendarView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    color: row.color,
    owner: row.owner_name || row.owner_username || null,
    group:
      row.group_id !== null && row.group_name !== null
        ? { id: row.group_id, name: row.group_name }
        : null,
    isDefault: row.kind === 'personal' && isDefaultCalendarPath(row.collection_path),
    collectionPath: row.collection_path,
    rules: viewRules(db, row.id),
  }
}

/** A calendar of the access page that a rule shares with the caller, as their sidebar names it. */
export interface SharedCalendarView {
  id: number
  name: string
  kind: AccessCalendarView['kind']
  /** The owner's name for a person's calendar; null for a calendar of the organization or a group. */
  owner: string | null
  /** The group that owns the calendar, or null. */
  groupId: number | null
  /** The caller manages that group: they may rename and delete the calendar (the routes check). */
  canManage: boolean
}

/**
 * The calendars a rule shares with `user` (as a person, through a group of theirs, or as somebody
 * signed in), not their own: the same rules the gateway's check reads. Name and owner only, so the
 * browser can tell "Personal Calendar (Alice)" from the person's own; nothing about the other rules.
 */
export function listCalendarsSharedWith(
  db: Database,
  user: { id: number; sub: string },
): SharedCalendarView[] {
  const manages = new Set(
    db
      .prepare<[string], number>('SELECT group_id FROM group_members WHERE sub = ? AND manager = 1')
      .pluck()
      .all(user.sub),
  )
  return db
    .prepare<[number, string, string], CalendarRow>(
      `${CALENDAR_SQL}
       WHERE (c.owner_id IS NULL OR c.owner_id <> ?)
         AND EXISTS (
           SELECT 1 FROM calendar_acl a
           WHERE a.calendar_id = c.id
             AND a.permission IN ('free_busy', 'read', 'write')
             AND (
               a.principal_type = 'authenticated'
               OR (a.principal_type = 'user' AND a.principal = ?)
               OR (a.principal_type = 'group' AND a.principal IN (
                 SELECT g.name FROM groups g
                 WHERE g.source = 'everyone'
                    OR g.id IN (SELECT m.group_id FROM group_members m WHERE m.sub = ?)
               ))
             )
         )
       ORDER BY c.id`,
    )
    .all(user.id, user.sub, user.sub)
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      owner: row.kind === 'personal' ? row.owner_name || row.owner_username || null : null,
      groupId: row.group_id,
      canManage: row.group_id !== null && manages.has(row.group_id),
    }))
}

export function listAccessCalendars(db: Database): AccessCalendarView[] {
  return db
    .prepare<[], CalendarRow>(CALENDAR_SQL + ' ORDER BY c.name COLLATE NOCASE, c.id')
    .all()
    .map((row) => toCalendarView(db, row))
}

export function getAccessCalendar(db: Database, id: number): AccessCalendarView | undefined {
  const row = getCalendarRow(db, id)
  return row ? toCalendarView(db, row) : undefined
}

export const MAX_PICKER_USERS = 2000

/** The picker's people: no tokens, no email. */
export function listAccessUsers(db: Database): AccessUserView[] {
  return db
    .prepare<[number], AccessUserView>(
      `SELECT oidc_sub AS sub, name, username FROM users
       ORDER BY COALESCE(NULLIF(name, ''), username, oidc_sub) COLLATE NOCASE, id LIMIT ?`,
    )
    .all(MAX_PICKER_USERS)
}

export interface ReplaceOutcome {
  changed: boolean
  /** Counts for the audit entry. */
  details: Record<string, unknown>
}

const keyOf = (type: string, principal: string | null, permission: string) =>
  `${type}\u0000${principal ?? ''}\u0000${permission}`

/** Replaces the rules in one transaction and says what changed. Throws AclError on bad rules. */
export function applyRules(
  db: Database,
  calendarId: number,
  rules: readonly CalendarAclInput[],
): ReplaceOutcome {
  const before = listCalendarAcl(db, calendarId)
  const after = replaceCalendarAcl(db, calendarId, rules)
  const was = new Set(before.map((r) => keyOf(r.principal_type, r.principal, r.permission)))
  const is = new Set(after.map((r) => keyOf(r.principal_type, r.principal, r.permission)))
  const added = [...is].filter((key) => !was.has(key)).length
  const removed = [...was].filter((key) => !is.has(key)).length
  const types: Record<string, number> = {}
  for (const rule of after) types[rule.principal_type] = (types[rule.principal_type] ?? 0) + 1
  return {
    changed: added > 0 || removed > 0,
    details: { before: before.length, after: after.length, added, removed, principalTypes: types },
  }
}
