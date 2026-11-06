// The shapes the SPA reads from its own `/api/**` routes (server/api/**). Declared here instead of
// importing the server's types so that no server code (better-sqlite3) leaks into the browser.

export interface ApiMe {
  id: number
  sub: string
  username: string | null
  name: string | null
  email: string | null
  isAdmin: boolean
  timeZone: string | null
  /** The order of the sidebar's sections (FR-21); null means the default. */
  sidebarOrder: string[] | null
}

export interface ApiViewCalendar {
  ref: string
  color: string | null
}

export interface ApiView {
  id: number
  name: string
  icon: string
  calendars: ApiViewCalendar[]
  isAdmin: boolean
  ownerId: number | null
}

/** A calendar an access rule shares with the viewer (`/api/shared-calendars`). */
export interface ApiSharedCalendar {
  id: number
  name: string
  kind: 'personal' | 'shared' | 'resource'
  /** The owner of a person's calendar; null otherwise. */
  owner: string | null
  /** The group that owns the calendar, or null. */
  groupId?: number | null
  /** The viewer manages that group, so they may rename and delete the calendar. */
  canManage?: boolean
}

export interface ApiFilter {
  id: number
  name: string
  kind: 'text' | 'category' | 'status'
  value: string
}

export interface ApiCategory {
  id: number
  name: string
  color: string | null
  shared: boolean
}

export interface ApiCalendarPref {
  ref: string
  color: string | null
  visible: boolean
}

export interface ApiIcalSubscription {
  id: number
  /** `ics:<id>`, the calendar ref. */
  ref: string
  name: string
  url: string
  color: string | null
  shared: boolean
}

/** A JSON request to the app's own API; the Nuxt glue binds it to the authenticated `$fetch`. */
export type ApiRequest = <T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    body?: unknown
    /** Sent as the query string, encoded by `$fetch`. */
    query?: Record<string, string>
  },
) => Promise<T>
