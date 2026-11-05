import type { Database } from 'better-sqlite3'
import type { FileGroup } from '../utils/groups/htgroup'
import { isValidSubject } from '../utils/auth/subject'
import type { CalendarRow, GroupRow, GroupSource } from './types'

// Rows of the `groups`, `group_members` and group-owned `calendars` tables (migration 009). The
// rules (names, limits, who may do what) live in server/utils/groups; this file only reads and
// writes rows. A write that must be audited is called inside the caller's transaction.

export interface GroupMemberView {
  sub: string
  name: string | null
  username: string | null
}

export interface GroupSummaryRow {
  id: number
  name: string
  source: GroupSource
  memberCount: number
  member: boolean
}

export function findGroupById(db: Database, id: number): GroupRow | undefined {
  return db.prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ?').get(id)
}

export function findGroupByName(db: Database, name: string): GroupRow | undefined {
  return db.prepare<[string], GroupRow>('SELECT * FROM groups WHERE name = ?').get(name)
}

/** The groups that count against the limit: the built-in group of everyone is not one of them. */
export function countGroups(db: Database): number {
  return db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM groups WHERE source <> 'everyone'`)
    .get()!.n
}

/**
 * Every group, by name; `member` says whether `sub` is in it. The group of everyone has no stored
 * members: it counts, and holds `sub`, by `users.last_seen_at >= since` (see `signinCutoff`).
 */
export function listGroupSummaries(db: Database, sub: string, since: string): GroupSummaryRow[] {
  return db
    .prepare<
      { sub: string; since: string },
      { id: number; name: string; source: GroupSource; memberCount: number; member: number }
    >(
      `SELECT g.id, g.name, g.source,
         CASE g.source
           WHEN 'everyone' THEN (SELECT COUNT(*) FROM users u WHERE u.last_seen_at >= @since)
           ELSE (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id)
         END AS memberCount,
         CASE g.source
           WHEN 'everyone' THEN EXISTS (
             SELECT 1 FROM users u WHERE u.oidc_sub = @sub AND u.last_seen_at >= @since)
           ELSE EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.sub = @sub)
         END AS member
       FROM groups g ORDER BY g.name COLLATE NOCASE, g.id`,
    )
    .all({ sub, since })
    .map((row) => ({ ...row, member: row.member === 1 }))
}

export function insertCustomGroup(db: Database, name: string): GroupRow {
  return db
    .prepare<[string], GroupRow>(`INSERT INTO groups (name, source) VALUES (?, 'app') RETURNING *`)
    .get(name)!
}

/** Deletes the row; its members go with it (ON DELETE CASCADE). */
export function deleteGroupRow(db: Database, id: number): boolean {
  return db.prepare('DELETE FROM groups WHERE id = ?').run(id).changes > 0
}

/**
 * Whether `sub` is in the group. The group of everyone holds a person seen since `since`; every
 * other group, a person in its stored members.
 */
export function isGroupMember(db: Database, groupId: number, sub: string, since: string): boolean {
  return (
    db
      .prepare<{ id: number; sub: string; since: string }, { one: number }>(
        `SELECT 1 AS one FROM groups g WHERE g.id = @id AND (
           (g.source <> 'everyone' AND EXISTS (
             SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.sub = @sub))
           OR (g.source = 'everyone' AND EXISTS (
             SELECT 1 FROM users u WHERE u.oidc_sub = @sub AND u.last_seen_at >= @since)))`,
      )
      .get({ id: groupId, sub, since }) !== undefined
  )
}

/** The stored members of a group; none for the group of everyone (it is counted, never listed). */
export function listGroupMembers(db: Database, groupId: number): GroupMemberView[] {
  return db
    .prepare<[number], GroupMemberView>(
      `SELECT m.sub AS sub, u.name AS name, u.username AS username
       FROM group_members m JOIN groups g ON g.id = m.group_id
       LEFT JOIN users u ON u.oidc_sub = m.sub
       WHERE m.group_id = ? AND g.source <> 'everyone'
       ORDER BY COALESCE(NULLIF(u.name, ''), u.username, m.sub) COLLATE NOCASE, m.sub`,
    )
    .all(groupId)
}

/**
 * Makes the members of a group exactly `subs` (already validated). Returns how many were added and
 * removed; the caller audits the change inside the same transaction.
 */
export function replaceGroupMembers(
  db: Database,
  groupId: number,
  subs: readonly string[],
): { added: number; removed: number } {
  const wanted = new Set(subs)
  const current = new Set(
    db
      .prepare<[number], string>('SELECT sub FROM group_members WHERE group_id = ?')
      .pluck()
      .all(groupId),
  )
  const remove = db.prepare('DELETE FROM group_members WHERE group_id = ? AND sub = ?')
  const insert = db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)')
  let removed = 0
  let added = 0
  db.transaction(() => {
    for (const sub of current) {
      if (!wanted.has(sub)) removed += remove.run(groupId, sub).changes
    }
    for (const sub of wanted) {
      if (!current.has(sub)) added += insert.run(groupId, sub).changes
    }
  })()
  return { added, removed }
}

/**
 * Every group of the group file with its members: the app's and the imported ones with their stored
 * members, and the group of everyone with the people seen since `since`. A member that is not a
 * valid user id (nothing writes one; this is the last guard before the file) is left out and
 * counted, so one bad row cannot stop the whole file.
 */
export function listGroupsForFile(
  db: Database,
  since: string,
): { groups: FileGroup[]; skipped: number } {
  const rows = db
    .prepare<[], { name: string; source: GroupSource; sub: string | null }>(
      `SELECT g.name AS name, g.source AS source, m.sub AS sub FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id
       WHERE g.source <> 'everyone' ORDER BY g.name, m.sub`,
    )
    .all()
  let skipped = 0
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const members = groups.get(row.name) ?? []
    if (row.sub !== null) {
      if (isValidSubject(row.sub)) members.push(row.sub)
      else skipped += 1
    }
    groups.set(row.name, members)
  }
  const everyone = db
    .prepare<[], { name: string }>(`SELECT name FROM groups WHERE source = 'everyone'`)
    .pluck()
    .all() as unknown as string[]
  const people = db
    .prepare<[string], string>(
      'SELECT oidc_sub FROM users WHERE last_seen_at >= ? ORDER BY oidc_sub',
    )
    .pluck()
    .all(since)
  for (const name of everyone) {
    const members: string[] = []
    for (const sub of people) {
      if (isValidSubject(sub)) members.push(sub)
      else skipped += 1
    }
    groups.set(name, members)
  }
  return { groups: [...groups].map(([name, members]) => ({ name, members })), skipped }
}

export function findGroupCalendar(
  db: Database,
  groupId: number,
  calendarId: number,
): CalendarRow | undefined {
  return db
    .prepare<[number, number], CalendarRow>('SELECT * FROM calendars WHERE id = ? AND group_id = ?')
    .get(calendarId, groupId)
}

export function listGroupCalendars(db: Database, groupId: number): CalendarRow[] {
  return db
    .prepare<[number], CalendarRow>(
      'SELECT * FROM calendars WHERE group_id = ? ORDER BY name COLLATE NOCASE, id',
    )
    .all(groupId)
}

export function countGroupCalendars(db: Database, groupId: number): number {
  return db
    .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM calendars WHERE group_id = ?')
    .get(groupId)!.n
}

/** The `group_id` of the calendar (or null) when the calendar exists. */
export function calendarOwningGroup(
  db: Database,
  calendarId: number,
): { exists: boolean; groupId: number | null } {
  const row = db
    .prepare<[number], { group_id: number | null }>('SELECT group_id FROM calendars WHERE id = ?')
    .get(calendarId)
  return row ? { exists: true, groupId: row.group_id } : { exists: false, groupId: null }
}

/** How many rules (calendar and resource) name a group; a delete removes them and says how many. */
export function countRulesNamingGroup(
  db: Database,
  name: string,
): { calendar: number; resource: number } {
  const calendar = db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM calendar_acl WHERE principal_type = 'group' AND principal = ?`,
    )
    .get(name)!.n
  const resource = db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM resource_acl WHERE principal_type = 'group' AND principal = ?`,
    )
    .get(name)!.n
  return { calendar, resource }
}

/** Removes every rule that names the group: its rows in calendar_acl and resource_acl. */
export function deleteRulesNamingGroup(db: Database, name: string): void {
  db.prepare(`DELETE FROM calendar_acl WHERE principal_type = 'group' AND principal = ?`).run(name)
  db.prepare(`DELETE FROM resource_acl WHERE principal_type = 'group' AND principal = ?`).run(name)
}

/** Every person who signed in once: no e-mail, no token. */
export function listPeopleRows(db: Database, limit: number): GroupMemberView[] {
  return db
    .prepare<[number], GroupMemberView>(
      `SELECT oidc_sub AS sub, NULLIF(name, '') AS name, username FROM users
       ORDER BY COALESCE(NULLIF(name, ''), username, oidc_sub) COLLATE NOCASE, id LIMIT ?`,
    )
    .all(limit)
}

/** Whether a user with this `sub` has signed in once. */
export function personExists(db: Database, sub: string): boolean {
  return (
    db
      .prepare<[string], { one: number }>('SELECT 1 AS one FROM users WHERE oidc_sub = ?')
      .get(sub) !== undefined
  )
}

/** Whether a group of either source has this name, ignoring case (names are compared that way). */
export function groupNameTaken(db: Database, name: string): boolean {
  return (
    db
      .prepare<[string], { one: number }>(
        'SELECT 1 AS one FROM groups WHERE name = ? COLLATE NOCASE',
      )
      .get(name) !== undefined
  )
}

export interface NewGroupCalendar {
  groupId: number
  name: string
  color: string | null
  collectionPath: string
}

/**
 * Inserts the row of a calendar a group owns. A row discovery already made for the same collection
 * (it lists the group's home) is taken over instead, so the two never disagree.
 */
export function upsertGroupCalendar(db: Database, calendar: NewGroupCalendar): CalendarRow {
  return db
    .prepare<[string, string | null, string, number], CalendarRow>(
      `INSERT INTO calendars (name, kind, owner_id, color, collection_path, group_id)
       VALUES (?, 'shared', NULL, ?, ?, ?)
       ON CONFLICT (collection_path) DO UPDATE SET
         name = excluded.name, color = excluded.color, group_id = excluded.group_id, kind = 'shared',
         owner_id = NULL
       RETURNING *`,
    )
    .get(calendar.name, calendar.color, calendar.collectionPath, calendar.groupId)!
}

export function updateCalendarNameColor(
  db: Database,
  calendarId: number,
  name: string,
  color: string | null,
): CalendarRow {
  return db
    .prepare<[string, string | null, number], CalendarRow>(
      'UPDATE calendars SET name = ?, color = ? WHERE id = ? RETURNING *',
    )
    .get(name, color, calendarId)!
}

/** Deletes the calendar row; its rules go with it (ON DELETE CASCADE). */
export function deleteCalendarRow(db: Database, calendarId: number): boolean {
  return db.prepare('DELETE FROM calendars WHERE id = ?').run(calendarId).changes > 0
}
