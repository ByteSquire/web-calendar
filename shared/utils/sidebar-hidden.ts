// The items a user has hidden from the sidebar (FR-21): calendars, resources, views, categories
// and filters. Hidden items leave their section for the "Hidden" section at the bottom and are
// switched off. The list is stored per user (`users.sidebar_hidden`, served in `/api/me`, set with
// `PUT /api/me/sidebar-hidden`), so it follows the person to every browser. An item is named by
// a key, its kind and its id: `calendar:dav:/caldav/<sub>/work/`, `resource:12`, `view:3`. A key
// of an item that is gone does no harm; it is dropped once the list is full.

export const SIDEBAR_HIDDEN_KINDS = ['calendar', 'resource', 'view', 'category', 'filter'] as const

export type SidebarHiddenKind = (typeof SIDEBAR_HIDDEN_KINDS)[number]

/** At most this many keys are kept; past it, the oldest go first. */
export const SIDEBAR_HIDDEN_MAX = 500

/** A key is at most this long (a calendar's id is its address, which is the longest part). */
export const SIDEBAR_HIDDEN_KEY_MAX = 600

export function sidebarHiddenKey(kind: SidebarHiddenKind, id: string): string {
  return `${kind}:${id}`
}

/** A key of a known kind with an id, of a sensible length and without control characters. */
export function isSidebarHiddenKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > SIDEBAR_HIDDEN_KEY_MAX) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  const colon = value.indexOf(':')
  return (
    colon > 0 &&
    colon < value.length - 1 &&
    (SIDEBAR_HIDDEN_KINDS as readonly string[]).includes(value.slice(0, colon))
  )
}

/**
 * The list for whatever was stored or received: the valid keys once each, in their order, the
 * newest `SIDEBAR_HIDDEN_MAX` of them. Anything that is not a list gives an empty one.
 */
export function readSidebarHidden(stored: unknown): string[] {
  if (!Array.isArray(stored)) return []
  const keys = [...new Set(stored.filter(isSidebarHiddenKey))]
  return keys.slice(Math.max(0, keys.length - SIDEBAR_HIDDEN_MAX))
}

/** The list with `key` hidden (added at the end) or shown again (removed). */
export function withSidebarHidden(list: readonly string[], key: string, hidden: boolean): string[] {
  const rest = list.filter((item) => item !== key)
  return readSidebarHidden(hidden ? [...rest, key] : rest)
}
