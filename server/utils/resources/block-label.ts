// Who the availability block of a booking names (block.ts): the requester by the name the app
// shows for them (their name, else their user name), and the group whose calendar holds the
// booking's event. The event's calendar is stored as the requester sees it: their own collection,
// or a share `/<sub>/shared-<id>[-<group>]/`. Only the calendar's owner says whose calendar it is
// (a `-<group>` suffix names the group it was shared with, not its owner), so a share is followed
// to its calendar, and a calendar owned by a group principal gives the group.
import type { Database } from 'better-sqlite3'
import { sharedCalendarId } from '../../../shared/utils/shared-calendar-name'
import { groupIdOfPrincipal, splitCollectionPath } from '../sharing/names'
import type { BlockLabel } from './block'

export function createBlockLabels(
  db: Database,
): (booking: { requester_id: number; event_calendar_path: string }) => BlockLabel {
  const person = db.prepare<[number], { name: string | null; username: string | null }>(
    'SELECT name, username FROM users WHERE id = ?',
  )
  const calendar = db.prepare<[number], { collection_path: string }>(
    'SELECT collection_path FROM calendars WHERE id = ?',
  )
  const group = db.prepare<[number], { name: string }>('SELECT name FROM groups WHERE id = ?')

  function groupOf(eventCalendarPath: string): string | null {
    const shared = splitCollectionPath(eventCalendarPath)
    const id = shared ? sharedCalendarId(shared.name) : null
    if (id === null) return null
    const row = calendar.get(id)
    const owner = row ? splitCollectionPath(row.collection_path)?.owner : undefined
    const groupId = owner === undefined ? null : groupIdOfPrincipal(owner)
    return groupId === null ? null : (group.get(groupId)?.name ?? null)
  }

  return (booking) => {
    const user = person.get(booking.requester_id)
    const requester = user?.name?.trim() || user?.username?.trim() || null
    return { requester, group: groupOf(booking.event_calendar_path) }
  }
}
