// Changing and deleting a calendar of any owner, in Radicale and in the rows: a person's own
// calendar (they or an admin), a group's (its managers or an admin) and the organization's (admins).
// The routes decide who may call; these functions ask Radicale first and change the rows after, so
// a refused or failed call leaves everything as it was. The calendar lives in the home of the
// principal that owns it, the first segment of its collection path.
import type { Database } from 'better-sqlite3'
import { deleteCalendarRow, updateCalendarNameColor } from '../../db/groups'
import type { CalendarRow } from '../../db/types'
import { conflict, upstreamFailed } from '../api/errors'
import { isDefaultCalendarPath } from '../../../shared/utils/default-calendar'
import { getGroupsPorts } from '../groups/ports'
import { splitCollectionPath } from '../sharing/names'
import type { RadicaleClient } from '../sharing/radicale-client'

export interface CalendarContext {
  db: Database
  /** Read when a Radicale call is about to be made, after the access check. */
  readonly radicale: RadicaleClient
  audit(action: string, target?: string, details?: Record<string, unknown>): void
  atomic<T>(work: () => T): T
}

/** The calendar context of a route: the Radicale client is built only after the access check. */
export function calendarContextOf(ctx: Omit<CalendarContext, 'radicale'>): CalendarContext {
  return {
    db: ctx.db,
    // The group routes' port: one Radicale client and one sharing trigger for every calendar.
    get radicale() {
      return getGroupsPorts().radicale()
    },
    audit: ctx.audit,
    atomic: ctx.atomic,
  }
}

/** A person's default calendar is kept (shared/utils/default-calendar.ts): 409 `default_calendar`. */
export function refuseDefaultCalendar(collectionPath: string): void {
  if (isDefaultCalendarPath(collectionPath)) {
    throw conflict(
      'default_calendar',
      'The default calendar cannot be deleted; it can be renamed, and its events deleted',
    )
  }
}

export const RADICALE_DOWN = 'The calendar server did not do it; nothing was changed. Try again.'

/** The owning principal and the encoded store path of a stored (decoded) collection path. */
export function collectionAddress(collectionPath: string): { principal: string; path: string } {
  const parts = splitCollectionPath(collectionPath)
  // Every stored path has this shape (discovery and the create routes write it); a row that does not
  // is not one Radicale could change.
  if (!parts) throw upstreamFailed(RADICALE_DOWN)
  return {
    principal: parts.owner,
    path: `/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/`,
  }
}

/** A new name or colour; undefined keeps it, a null colour clears it. */
export interface CalendarChange {
  name?: string
  color?: string | null
}

/**
 * Renames or recolours a calendar in Radicale and in its row. Radicale is asked only for what
 * changes (a rename of an uncoloured calendar leaves its colour alone), in one PROPPATCH: it takes
 * both or neither, so the row never disagrees with it. `record` writes the audit entry inside the
 * row's transaction. Returns the row as it is now.
 */
export async function changeCalendar(
  ctx: CalendarContext,
  current: CalendarRow,
  input: CalendarChange,
  record: (row: CalendarRow, colorCleared: boolean) => void,
): Promise<CalendarRow> {
  const name = input.name ?? current.name
  const color = input.color === undefined ? current.color : input.color
  if (name === current.name && color === current.color) return current
  const { principal, path } = collectionAddress(current.collection_path)
  const changed = await ctx.radicale.updateCalendar(principal, path, {
    ...(name !== current.name ? { displayName: name } : {}),
    ...(color !== current.color ? { color } : {}),
  })
  if (!changed.ok) throw upstreamFailed(RADICALE_DOWN)
  return ctx.atomic(() => {
    const row = updateCalendarNameColor(ctx.db, current.id, name, color)
    record(row, color === null && current.color !== null)
    return row
  })
}

/**
 * Radicale refuses to delete a collection that a share still maps (409, found by the live proof),
 * so the shares of the collection go first. If the collection is then not deleted, the rows still
 * hold the rules and the next reconcile puts the shares back: nothing is lost.
 */
export async function removeMappedShares(
  radicale: RadicaleClient,
  principal: string,
  collectionPath: string,
): Promise<boolean> {
  const listed = await radicale.listShares(principal, 'map')
  if (!listed.ok) return false
  for (const share of listed.value) {
    if (share.pathMapped !== collectionPath) continue
    const removed = await radicale.deleteShare(principal, 'map', share.pathOrToken)
    if (!removed.ok) return false
  }
  return true
}

/**
 * Deletes a calendar: its shares and its collection in Radicale, then its row (with the rules and
 * the links that name it) and the links made to its path before the app knew the calendar.
 * `row` is undefined for a calendar of a person's own that discovery has not listed yet. `record`
 * writes the audit entry inside the transaction. Throws 502, with nothing deleted, when Radicale
 * fails; the shares that were removed come back with the next reconcile.
 */
export async function deleteCalendar(
  ctx: CalendarContext,
  collectionPath: string,
  row: CalendarRow | undefined,
  record: (links: number) => void,
): Promise<void> {
  const { principal, path } = collectionAddress(collectionPath)
  if (!(await removeMappedShares(ctx.radicale, principal, collectionPath))) {
    throw upstreamFailed(RADICALE_DOWN)
  }
  const gone = await ctx.radicale.deleteCollection(principal, path)
  if (!gone.ok) {
    // The shares are gone and the rows are still there: have the writer put them back.
    getGroupsPorts().onSharesChanged()
    throw upstreamFailed(RADICALE_DOWN)
  }
  ctx.atomic(() => {
    const links = countLinksOf(ctx.db, collectionPath, row?.id ?? null)
    ctx.db.prepare('DELETE FROM calendar_links WHERE collection_path = ?').run(collectionPath)
    // Rules and links with the calendar's id go with the row (ON DELETE CASCADE).
    if (row) deleteCalendarRow(ctx.db, row.id)
    record(links)
  })
  // The shares of the calendar are removed by the next reconcile (its rules are gone).
  getGroupsPorts().onSharesChanged()
}

/** The links that stop working with the calendar: to its path, or tied to its row. */
function countLinksOf(db: Database, collectionPath: string, calendarId: number | null): number {
  return db
    .prepare<[string, number], { n: number }>(
      'SELECT COUNT(*) AS n FROM calendar_links WHERE collection_path = ? OR calendar_id = ?',
    )
    .get(collectionPath, calendarId ?? -1)!.n
}
