// Per-user calendar preferences (FR-4, FR-5): a color override and the sidebar visibility toggle,
// keyed by calendar ref. The server does not check that the calendar exists; a pref for a calendar
// that is gone is harmless and the client can reset it.
import type { Database } from 'better-sqlite3'
import { conflict } from '../utils/api/errors'
import type { CalendarPrefRow } from './types'

export const MAX_PREFS_PER_USER = 500

export interface CalendarPrefEntry {
  ref: string
  /** `#rrggbb`, or null for the calendar's own color. */
  color: string | null
  visible: boolean
}

/**
 * A validated body. An omitted field (`undefined`) keeps the stored value; `color: null` clears
 * the override.
 */
export interface CalendarPrefInput {
  ref: string
  color?: string | null
  visible?: boolean
}

function toPref(
  row: Pick<CalendarPrefRow, 'calendar_ref' | 'color' | 'visible'>,
): CalendarPrefEntry {
  return { ref: row.calendar_ref, color: row.color, visible: row.visible === 1 }
}

/** The user's prefs, sorted by ref so the order is stable. */
export function listCalendarPrefs(db: Database, userId: number): CalendarPrefEntry[] {
  return db
    .prepare<[number], CalendarPrefRow>(
      'SELECT * FROM calendar_prefs WHERE user_id = ? ORDER BY calendar_ref',
    )
    .all(userId)
    .map(toPref)
}

/**
 * Creates the pref (visible, no color) or changes the given fields of the existing one. Throws a
 * 409 `limit_reached` when a new ref would be the 501st.
 */
export function setCalendarPref(
  db: Database,
  userId: number,
  input: CalendarPrefInput,
): CalendarPrefEntry {
  const set = db.transaction(() => {
    const exists = db
      .prepare<[number, string], 1>(
        'SELECT 1 FROM calendar_prefs WHERE user_id = ? AND calendar_ref = ?',
      )
      .get(userId, input.ref)
    if (!exists) {
      const { count } = db
        .prepare<[number], { count: number }>(
          'SELECT COUNT(*) AS count FROM calendar_prefs WHERE user_id = ?',
        )
        .get(userId)!
      if (count >= MAX_PREFS_PER_USER) {
        throw conflict(
          'limit_reached',
          `At most ${MAX_PREFS_PER_USER} calendar preferences are allowed per user`,
        )
      }
    }
    return db
      .prepare<
        {
          userId: number
          ref: string
          setColor: 0 | 1
          color: string | null
          visible: 0 | 1 | null
        },
        CalendarPrefRow
      >(
        `INSERT INTO calendar_prefs (user_id, calendar_ref, color, visible)
         VALUES (@userId, @ref, CASE WHEN @setColor THEN @color END, COALESCE(@visible, 1))
         ON CONFLICT (user_id, calendar_ref) DO UPDATE SET
           color = CASE WHEN @setColor THEN @color ELSE color END,
           visible = COALESCE(@visible, visible)
         RETURNING *`,
      )
      .get({
        userId,
        ref: input.ref,
        setColor: input.color === undefined ? 0 : 1,
        color: input.color ?? null,
        visible: input.visible === undefined ? null : input.visible ? 1 : 0,
      })!
  })
  return toPref(set.immediate())
}

/** Removes the pref so the calendar is shown with its own color again. Quiet when there is none. */
export function deleteCalendarPref(db: Database, userId: number, ref: string): void {
  db.prepare('DELETE FROM calendar_prefs WHERE user_id = ? AND calendar_ref = ?').run(userId, ref)
}
