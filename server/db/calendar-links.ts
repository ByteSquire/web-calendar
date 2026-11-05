import type { Database } from 'better-sqlite3'

// Rows of `calendar_links` (migrations 011 and 012). The rules (who may make a link, what is
// checked) live in server/utils/links; this file reads and writes rows. A list never carries a hash
// or the sealed secret out of the server: the routes open the secret for the ones who may see it.

export type LinkLevel = 'read' | 'free_busy'
export type LinkReadsAs = 'maker' | 'owner'

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
  level: LinkLevel
  reads_as: LinkReadsAs
  calendar_id: number | null
  secret_sealed: string | null
}

/** A link with its maker, as the lists and the public routes need it. */
export interface CalendarLinkWithMaker extends CalendarLinkRow {
  maker_sub: string
  maker_name: string | null
  maker_username: string | null
  maker_last_seen_at: string | null
}

/** `last_used_at` is written at most this often, so a busy page does not write on every read. */
const LAST_USED_INTERVAL_MS = 60 * 60 * 1000

const WITH_MAKER = `SELECT l.*, u.oidc_sub AS maker_sub, u.name AS maker_name,
    u.username AS maker_username, u.last_seen_at AS maker_last_seen_at
  FROM calendar_links l JOIN users u ON u.id = l.user_id`

export interface NewCalendarLink {
  userId: number
  collectionPath: string
  calendarName: string
  calendarColor: string | null
  label: string
  slugHash: string
  passwordHash: string
  level: LinkLevel
  readsAs: LinkReadsAs
  calendarId: number | null
  secretSealed: string
}

export function insertCalendarLink(db: Database, link: NewCalendarLink): CalendarLinkWithMaker {
  const id = Number(
    db
      .prepare<NewCalendarLink>(
        `INSERT INTO calendar_links
           (user_id, collection_path, calendar_name, calendar_color, label, slug_hash, password_hash,
            level, reads_as, calendar_id, secret_sealed)
         VALUES (@userId, @collectionPath, @calendarName, @calendarColor, @label, @slugHash,
            @passwordHash, @level, @readsAs, @calendarId, @secretSealed)`,
      )
      .run(link).lastInsertRowid,
  )
  return findCalendarLinkById(db, id)!
}

export function findCalendarLinkById(db: Database, id: number): CalendarLinkWithMaker | null {
  return db.prepare<[number], CalendarLinkWithMaker>(`${WITH_MAKER} WHERE l.id = ?`).get(id) ?? null
}

/** The links a person made, newest first. */
export function listCalendarLinksOfUser(db: Database, userId: number): CalendarLinkWithMaker[] {
  return db
    .prepare<[number], CalendarLinkWithMaker>(
      `${WITH_MAKER} WHERE l.user_id = ? ORDER BY l.created_at DESC, l.id DESC`,
    )
    .all(userId)
}

/** Every link to a calendar of the access page, whoever made it, newest first. */
export function listCalendarLinksOfCalendar(
  db: Database,
  calendarId: number,
): CalendarLinkWithMaker[] {
  return db
    .prepare<[number], CalendarLinkWithMaker>(
      `${WITH_MAKER} WHERE l.calendar_id = ? ORDER BY l.created_at DESC, l.id DESC`,
    )
    .all(calendarId)
}

export function countCalendarLinks(db: Database, userId: number): number {
  return db
    .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM calendar_links WHERE user_id = ?')
    .get(userId)!.n
}

export function countCalendarLinksOfCalendar(db: Database, calendarId: number): number {
  return db
    .prepare<[number], { n: number }>(
      'SELECT COUNT(*) AS n FROM calendar_links WHERE calendar_id = ?',
    )
    .get(calendarId)!.n
}

/** Deletes a link; false when there is none of that id. */
export function deleteCalendarLink(db: Database, id: number): boolean {
  return db.prepare('DELETE FROM calendar_links WHERE id = ?').run(id).changes > 0
}

/** The link with this slug hash, with its maker; null when there is none (or it was removed). */
export function findCalendarLinkBySlugHash(
  db: Database,
  slugHash: string,
): CalendarLinkWithMaker | null {
  return (
    db
      .prepare<[string], CalendarLinkWithMaker>(`${WITH_MAKER} WHERE l.slug_hash = ?`)
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
