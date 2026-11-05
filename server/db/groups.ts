import type { Database } from 'better-sqlite3'
import type { FileGroup, ImportedGroup } from '../utils/group-sync/types'
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

export function countGroups(db: Database): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM groups').get()!.n
}

/** Every group, by name; `member` says whether `sub` is in it. */
export function listGroupSummaries(db: Database, sub: string): GroupSummaryRow[] {
  return db
    .prepare<
      [string],
      { id: number; name: string; source: GroupSource; memberCount: number; member: number }
    >(
      `SELECT g.id, g.name, g.source,
         (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS memberCount,
         EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.sub = ?) AS member
       FROM groups g ORDER BY g.name COLLATE NOCASE, g.id`,
    )
    .all(sub)
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

export function isGroupMember(db: Database, groupId: number, sub: string): boolean {
  return (
    db
      .prepare<[number, string], { one: number }>(
        'SELECT 1 AS one FROM group_members WHERE group_id = ? AND sub = ?',
      )
      .get(groupId, sub) !== undefined
  )
}

export function listGroupMembers(db: Database, groupId: number): GroupMemberView[] {
  return db
    .prepare<[number], GroupMemberView>(
      `SELECT m.sub AS sub, u.name AS name, u.username AS username
       FROM group_members m LEFT JOIN users u ON u.oidc_sub = m.sub
       WHERE m.group_id = ?
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

/** The app's groups with their members, for the htgroup file: members are `sub` UUIDs. */
export function listCustomGroupsForFile(db: Database): FileGroup[] {
  const rows = db
    .prepare<[], { name: string; sub: string | null }>(
      `SELECT g.name AS name, m.sub AS sub FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id
       WHERE g.source = 'app' ORDER BY g.name, m.sub`,
    )
    .all()
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const members = groups.get(row.name) ?? []
    if (row.sub !== null) members.push(row.sub)
    groups.set(row.name, members)
  }
  return [...groups].map(([name, members]) => ({ name, members }))
}

/**
 * Stores what the sync read from Kanidm, in one transaction. A name that belongs to an app group
 * is skipped (the app's group wins). A Kanidm group that is no longer in `groups` loses its
 * members; its row goes too unless it owns a calendar (the rules naming it keep their text).
 */
export function replaceImportedGroups(
  db: Database,
  imported: readonly ImportedGroup[],
): { created: number; updated: number; cleared: number; removed: number } {
  const names = new Set(imported.map((group) => group.name))
  const counts = { created: 0, updated: 0, cleared: 0, removed: 0 }
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO groups (name, source) VALUES (?, 'kanidm') ON CONFLICT (name) DO NOTHING`,
    )
    for (const group of imported) {
      const inserted = insert.run(group.name).changes > 0
      const row = findGroupByName(db, group.name)
      // An app group with this name keeps its members; this run does not touch it.
      if (!row || row.source !== 'kanidm') continue
      if (inserted) counts.created += 1
      else counts.updated += 1
      if (!group.keepMembers) replaceGroupMembers(db, row.id, group.members)
    }
    const vanished = db
      .prepare<[], GroupRow>(`SELECT * FROM groups WHERE source = 'kanidm' ORDER BY id`)
      .all()
      .filter((row) => !names.has(row.name))
    for (const row of vanished) {
      counts.cleared += 1
      replaceGroupMembers(db, row.id, [])
      const owns = db
        .prepare<[number], { one: number }>('SELECT 1 AS one FROM calendars WHERE group_id = ?')
        .get(row.id)
      if (owns === undefined) {
        db.prepare('DELETE FROM groups WHERE id = ?').run(row.id)
        counts.removed += 1
      }
    }
  })()
  return counts
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
