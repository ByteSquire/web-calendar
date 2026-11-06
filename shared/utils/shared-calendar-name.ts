// How a calendar shared with a person is named in their home: `shared-<id>` for a share with the
// person, `shared-<id>-<group>` for one with a group (the sharing writer, server/utils/sharing). The
// id is the calendar of the access page: the gateway's check reads its rules by it, and the browser
// names the calendar's owner by it.

const SHARED_NAME = /^shared-([1-9][0-9]{0,14})(?:-[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$/

/** The calendar id a home collection name refers to, or null for an ordinary collection. */
export function sharedCalendarId(name: string): number | null {
  const match = SHARED_NAME.exec(name)
  return match ? Number(match[1]) : null
}
