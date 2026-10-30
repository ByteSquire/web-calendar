// Views (FR-1..FR-5): a named list of calendar refs with colors. The list is stored as JSON in
// `views.definition`. A user changes only their own views; admin views (`is_admin = 1`) are shown
// to everybody and are read-only here (admins get to manage them in Phase 3).
import type { Database } from 'better-sqlite3'
import { conflict } from '../utils/api/errors'
import type { ViewRow } from './types'

export const MAX_VIEWS_PER_USER = 100
export const MAX_CALENDARS_PER_VIEW = 200
export const VIEW_ICONS = ['calendar', 'users', 'layers', 'shield', 'star'] as const
export type ViewIconName = (typeof VIEW_ICONS)[number]

export interface ViewCalendar {
  /** `dav:...`, `ics:...` or `ext:...` (see `Calendar.id`). */
  ref: string
  /** `#rrggbb`, or null for the calendar's own color. */
  color: string | null
}

export interface ViewEntry {
  id: number
  name: string
  icon: string
  calendars: ViewCalendar[]
  isAdmin: boolean
  ownerId: number | null
}

/** A validated create or update body. */
export interface ViewInput {
  name: string
  icon: ViewIconName
  calendars: ViewCalendar[]
}

/**
 * Reads the stored JSON list. A row written by anything but this module may be odd; entries that
 * do not look like `{ ref, color }` are skipped so one bad row cannot break the whole list.
 */
function parseDefinition(text: string): ViewCalendar[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(json)) return []
  const calendars: ViewCalendar[] = []
  for (const entry of json) {
    if (typeof entry !== 'object' || entry === null) continue
    const { ref, color } = entry as Record<string, unknown>
    if (typeof ref !== 'string' || ref === '') continue
    calendars.push({ ref, color: typeof color === 'string' ? color : null })
  }
  return calendars
}

function toView(row: ViewRow): ViewEntry {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? 'calendar',
    calendars: parseDefinition(row.definition),
    isAdmin: row.is_admin === 1,
    ownerId: row.owner_id,
  }
}

function serialize(calendars: ViewCalendar[]): string {
  return JSON.stringify(calendars.map(({ ref, color }) => ({ ref, color })))
}

/** The user's own views and all admin views, oldest first. */
export function listViews(db: Database, userId: number): ViewEntry[] {
  return db
    .prepare<[number], ViewRow>(
      'SELECT * FROM views WHERE is_admin = 1 OR owner_id = ? ORDER BY id',
    )
    .all(userId)
    .map(toView)
}

/** Throws a 409 `limit_reached` when the user has `MAX_VIEWS_PER_USER` views already. */
export function createView(db: Database, userId: number, input: ViewInput): ViewEntry {
  const create = db.transaction(() => {
    const { count } = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM views WHERE owner_id = ? AND is_admin = 0',
      )
      .get(userId)!
    if (count >= MAX_VIEWS_PER_USER) {
      throw conflict('limit_reached', `At most ${MAX_VIEWS_PER_USER} views are allowed per user`)
    }
    return db
      .prepare<[string, string, number, string], ViewRow>(
        `INSERT INTO views (name, icon, owner_id, is_admin, definition) VALUES (?, ?, ?, 0, ?)
         RETURNING *`,
      )
      .get(input.name, input.icon, userId, serialize(input.calendars))!
  })
  return toView(create.immediate())
}

/** Replaces name, icon and calendars. Null when the user has no such view of their own. */
export function updateView(
  db: Database,
  userId: number,
  id: number,
  input: ViewInput,
): ViewEntry | null {
  const row = db
    .prepare<[string, string, string, number, number], ViewRow>(
      `UPDATE views SET name = ?, icon = ?, definition = ?
       WHERE id = ? AND owner_id = ? AND is_admin = 0 RETURNING *`,
    )
    .get(input.name, input.icon, serialize(input.calendars), id, userId)
  return row ? toView(row) : null
}

/** False when the user has no such view of their own (an admin view cannot be deleted here). */
export function deleteView(db: Database, userId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM views WHERE id = ? AND owner_id = ? AND is_admin = 0').run(id, userId)
      .changes > 0
  )
}
