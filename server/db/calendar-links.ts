import type { Database } from 'better-sqlite3'

// Rows of `calendar_links` (migration 011). The rules (who may make a link, what is checked) live in
// server/utils/links; this file reads and writes rows. Nothing here returns a hash to a caller that
// lists links.

export interface CalendarLinkRow {
  id: number
  user_id: number
  collection_path: string
  calendar_name: string
  calendar_color: string | null
  label: string
  slug_hash: string
  password_hash: string
  last_used_at: string | null
  created_at: string
  updated_at: string
}

/** A link as its maker sees it in the list: no hash. */
export interface CalendarLinkSummary {
  id: number
  label: string
  calendarName: string
  calendarColor: string | null
  collectionPath: string
  createdAt: string
  lastUsedAt: string | null
}

/** A link with what the public routes need: the maker's `sub` and when they were last seen. */
export interface CalendarLinkForRead extends CalendarLinkRow {
  owner_sub: string
  owner_last_seen_at: string | null
}

/** `last_used_at` is written at most this often, so a busy page does not write on every read. */
const LAST_USED_INTERVAL_MS = 60 * 60 * 1000

function toSummary(row: CalendarLinkRow): CalendarLinkSummary {
  return {
    id: row.id,
    label: row.label,
    calendarName: row.calendar_name,
    calendarColor: row.calendar_color,
    collectionPath: row.collection_path,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export interface NewCalendarLink {
  userId: number
  collectionPath: string
  calendarName: string
  calendarColor: string | null
  label: string
  slugHash: string
  passwordHash: string
}

export function insertCalendarLink(db: Database, link: NewCalendarLink): CalendarLinkSummary {
  const row = db
    .prepare<NewCalendarLink, CalendarLinkRow>(
      `INSERT INTO calendar_links
         (user_id, collection_path, calendar_name, calendar_color, label, slug_hash, password_hash)
       VALUES (@userId, @collectionPath, @calendarName, @calendarColor, @label, @slugHash, @passwordHash)
       RETURNING *`,
    )
    .get(link)!
  return toSummary(row)
}

export function listCalendarLinks(db: Database, userId: number): CalendarLinkSummary[] {
  return db
    .prepare<[number], CalendarLinkRow>(
      'SELECT * FROM calendar_links WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    )
    .all(userId)
    .map(toSummary)
}

export function countCalendarLinks(db: Database, userId: number): number {
  return db
    .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM calendar_links WHERE user_id = ?')
    .get(userId)!.n
}

/** Deletes one of the user's links; false when there is none of that id that is theirs. */
export function deleteCalendarLink(
  db: Database,
  userId: number,
  id: number,
): CalendarLinkSummary | null {
  const row = db
    .prepare<[number, number], CalendarLinkRow>(
      'DELETE FROM calendar_links WHERE id = ? AND user_id = ? RETURNING *',
    )
    .get(id, userId)
  return row ? toSummary(row) : null
}

/** The link with this slug hash, with its maker; null when there is none (or it was withdrawn). */
export function findCalendarLinkBySlugHash(
  db: Database,
  slugHash: string,
): CalendarLinkForRead | null {
  return (
    db
      .prepare<[string], CalendarLinkForRead>(
        `SELECT l.*, u.oidc_sub AS owner_sub, u.last_seen_at AS owner_last_seen_at
         FROM calendar_links l JOIN users u ON u.id = l.user_id WHERE l.slug_hash = ?`,
      )
      .get(slugHash) ?? null
  )
}

/** Notes a use of the link, at most once an hour. */
export function touchCalendarLink(db: Database, link: CalendarLinkRow, now = new Date()): void {
  const last = link.last_used_at ? Date.parse(link.last_used_at) : Number.NaN
  if (Number.isFinite(last) && now.getTime() - last < LAST_USED_INTERVAL_MS) return
  db.prepare('UPDATE calendar_links SET last_used_at = ? WHERE id = ?').run(
    now.toISOString(),
    link.id,
  )
}
