import type { Database } from 'better-sqlite3'
import type { CalendarRow } from './types'

// Rows of the `calendars` table that are not a group's (those are in db/groups.ts): a person's own,
// found by path, and the organization's, which admins make on Admin › Calendars. Discovery fills
// the rest (server/utils/sharing/calendars.ts).

export function findCalendarById(db: Database, id: number): CalendarRow | undefined {
  return db.prepare<[number], CalendarRow>('SELECT * FROM calendars WHERE id = ?').get(id)
}

export function findCalendarByPath(db: Database, path: string): CalendarRow | undefined {
  return db
    .prepare<[string], CalendarRow>('SELECT * FROM calendars WHERE collection_path = ?')
    .get(path)
}

/** The calendars of the organization: shared, of no person and no group, in `owner`'s home. */
export function countOrganizationCalendars(db: Database, owner: string): number {
  return db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM calendars
       WHERE kind = 'shared' AND owner_id IS NULL AND group_id IS NULL
         AND substr(collection_path, 1, length(?) + 2) = '/' || ? || '/'`,
    )
    .get(owner, owner)!.n
}

/**
 * Inserts the row of a calendar of the organization. A row discovery already made for the same
 * collection is taken over instead, so the two never disagree.
 */
export function upsertOrganizationCalendar(
  db: Database,
  calendar: { name: string; color: string | null; collectionPath: string },
): CalendarRow {
  return db
    .prepare<[string, string | null, string], CalendarRow>(
      `INSERT INTO calendars (name, kind, owner_id, color, collection_path, group_id)
       VALUES (?, 'shared', NULL, ?, ?, NULL)
       ON CONFLICT (collection_path) DO UPDATE SET
         name = excluded.name, color = excluded.color, kind = 'shared', owner_id = NULL,
         group_id = NULL
       RETURNING *`,
    )
    .get(calendar.name, calendar.color, calendar.collectionPath)!
}

/** The calendars a person owns (their home), by name. */
export function listCalendarsOfOwner(db: Database, userId: number): CalendarRow[] {
  return db
    .prepare<[number], CalendarRow>(
      'SELECT * FROM calendars WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id',
    )
    .all(userId)
}
