// Row types of the tables in migrations/*.sql, written by hand (design §12). Columns keep
// their database names; booleans are 0/1 and timestamps are ISO 8601 UTC strings.

export type CalendarKind = 'personal' | 'shared' | 'resource'
export type PrincipalType = 'user' | 'group' | 'authenticated' | 'public'
export type Permission = 'free_busy' | 'read' | 'write' | 'admin'
export type FilterKind = 'text' | 'category' | 'status'
export type ResourceType = 'room' | 'car' | 'equipment'

interface Timestamps {
  created_at: string
  updated_at: string
}

export interface UserRow extends Timestamps {
  id: number
  oidc_sub: string
  username: string | null
  name: string | null
  email: string | null
  /**
   * INFORMATIONAL ONLY: whether the last userinfo answer that carried a `groups` claim named the
   * admin group. It goes stale (a removed admin keeps 1 until the next `/api/me`) and must never
   * decide anything. The only admin check is `requireAdmin` (server/utils/api/handler.ts).
   */
  is_admin: 0 | 1
  last_seen_at: string | null
  /** An IANA zone name the user chose (FR-32); null means the browser's zone. */
  time_zone: string | null
}

export interface AppTokenRow extends Timestamps {
  id: number
  user_id: number
  label: string
  token_hash: string
  expires_at: string
  last_used_at: string | null
}

export interface CalendarRow extends Timestamps {
  id: number
  name: string
  kind: CalendarKind
  owner_id: number | null
  color: string | null
  collection_path: string
}

export interface CalendarAclRow extends Timestamps {
  id: number
  calendar_id: number
  principal_type: PrincipalType
  /** Null for `authenticated` and `public`. */
  principal: string | null
  permission: Permission
}

export interface ViewRow extends Timestamps {
  id: number
  name: string
  icon: string | null
  owner_id: number | null
  is_admin: 0 | 1
  /** JSON text. */
  definition: string
}

export interface CalendarPrefRow extends Timestamps {
  user_id: number
  calendar_ref: string
  color: string | null
  visible: 0 | 1
}

export interface CategoryRow extends Timestamps {
  id: number
  name: string
  color: string | null
  owner_id: number | null
}

export interface FilterRow extends Timestamps {
  id: number
  owner_id: number
  name: string
  kind: FilterKind
  value: string
}

export interface IcalSubscriptionRow extends Timestamps {
  id: number
  owner_id: number | null
  name: string
  url: string
  color: string | null
}

export interface ResourceRow extends Timestamps {
  id: number
  calendar_id: number
  name: string
  type: ResourceType
  location: string | null
  capacity: number | null
}

/** A user as the rest of the server sees it. */
export interface User {
  id: number
  sub: string
  username: string | null
  name: string | null
  email: string | null
  /** The informational copy of `is_admin`; see `UserRow.is_admin`. Not an authorization. */
  isAdmin: boolean
  lastSeenAt: string | null
  /** The zone the user chose to see times in (FR-32); null means the browser's zone. */
  timeZone: string | null
}
