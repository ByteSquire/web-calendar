import { AVAILABILITY_SHARE_NAME } from './types'

// How a shared calendar is named in a member's home. The gateway pre-check relies on it: the
// calendar id in the name says which access rules apply, so no extra table is needed.

const SHARED_NAME = /^shared-([1-9][0-9]{0,14})(?:-[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$/

/** Every group principal starts with this; no person's id may (`isReservedPrincipal`). */
export const GROUP_PRINCIPAL_PREFIX = '_group-'

/**
 * The Radicale principal of a group. It owns the group's calendar collections (`/_group-<id>/<uuid>/`)
 * and is never a person: its id is the `groups.id`, which is never reused.
 */
export function groupPrincipal(groupId: number): string {
  return `${GROUP_PRINCIPAL_PREFIX}${groupId}`
}

const GROUP_PRINCIPAL = /^_group-([1-9][0-9]{0,14})$/

/** The `groups.id` a principal names, or null when it is not a group principal. */
export function groupIdOfPrincipal(principal: string): number | null {
  const match = GROUP_PRINCIPAL.exec(principal)
  return match ? Number(match[1]) : null
}

/** Home collection of a user share of calendar `id`. */
export function userShareName(calendarId: number): string {
  return `shared-${calendarId}`
}

/** Home collection of a group share; `{user}` is Radicale's placeholder for the member. */
export function groupShareName(calendarId: number, group: string): string {
  return `shared-${calendarId}-${group}`
}

/** The calendar id a home collection name refers to, or null for an ordinary collection. */
export function sharedCalendarId(name: string): number | null {
  const match = SHARED_NAME.exec(name)
  return match ? Number(match[1]) : null
}

/** A home collection the sharing writer created (so discovery and the audit job skip it). */
export function isShareName(name: string): boolean {
  return sharedCalendarId(name) !== null || name === AVAILABILITY_SHARE_NAME
}

/** `/owner/cal/` for a stored collection path, or null when it is not a calendar path. */
export function splitCollectionPath(path: string): { owner: string; name: string } | null {
  const parts = /^\/([^/]+)\/([^/]+)\/$/.exec(path)
  return parts ? { owner: parts[1]!, name: parts[2]! } : null
}
