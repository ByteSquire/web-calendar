// Row types of the tables in migrations/*.sql, written by hand (design §12). Columns keep
// their database names; booleans are 0/1 and timestamps are ISO 8601 UTC strings.

import type { SidebarSectionId } from '../../shared/utils/sidebar-sections'

export type CalendarKind = 'personal' | 'shared' | 'resource'
export type PrincipalType = 'user' | 'group' | 'authenticated' | 'public'
export type Permission = 'free_busy' | 'read' | 'write' | 'admin'
export type FilterKind = 'text' | 'category' | 'status'
export type ResourceType = 'room' | 'car' | 'equipment'
export type ResourceAclPrincipalType = 'user' | 'group' | 'authenticated'
export type ResourceRight = 'read' | 'book' | 'manage'
export type BookingStatus = 'pending' | 'approved' | 'declined' | 'cancelled'

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
  /** The order of the sidebar's sections (FR-21), a JSON list of ids; null means the default. */
  sidebar_order: string | null
}

export interface AppTokenRow extends Timestamps {
  id: number
  user_id: number
  label: string
  token_hash: string
  /** The version of the hash key that made `token_hash` (migration 003); 1 for the first key. */
  key_version: number
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
  /** The group that owns the calendar (migration 009); null for every other calendar. */
  group_id: number | null
}

/** `app`: made in the app; `oidc`: imported from the identity provider; `everyone`: built in. */
export type GroupSource = 'app' | 'oidc' | 'everyone'

export interface GroupRow extends Timestamps {
  id: number
  /** The htgroup name and the principal of calendar_acl rules. */
  name: string
  source: GroupSource
  /** The provider's key of an imported group (its id, else its name); null for the others. */
  external_id: string | null
}

/** A group the provider's claim has shown (migration 009): an admin may import it. */
export interface OidcGroupCandidateRow {
  external_id: string
  /** The group-file safe name the group would get. */
  name: string
  /** 1 when another key of the claim has the same safe name. */
  conflict: 0 | 1
  first_seen_at: string
  last_seen_at: string
}

export interface GroupMemberRow {
  group_id: number
  /** The identity provider's `sub`, exactly as sent (case-sensitive). */
  sub: string
  created_at: string
}

export interface CalendarAclRow extends Timestamps {
  id: number
  calendar_id: number
  principal_type: PrincipalType
  /** A user's `sub` or a group name; null for `authenticated` and `public`. */
  principal: string | null
  permission: Permission
  /** When Radicale confirmed the share; null until then (migration 006). */
  applied_at: string | null
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

export interface ExternalAccountRow extends Timestamps {
  id: number
  user_id: number
  name: string
  url: string
  /** Derived from `url` (`new URL(url).origin`); what the proxy connects to and the seal is bound to. */
  origin: string
  auth_mode: 'none' | 'basic'
  /** Set exactly when `auth_mode` is `basic`. */
  username: string | null
  color: string | null
}

export interface ResourceRow extends Timestamps {
  id: number
  name: string
  type: ResourceType
  location: string | null
  capacity: number | null
  description: string | null
  /** Deactivated resources keep their bookings but accept no new ones. */
  active: 0 | 1
}

export interface ResourceAclRow extends Timestamps {
  id: number
  resource_id: number
  principal_type: ResourceAclPrincipalType
  /** Null for `authenticated`. */
  principal: string | null
  right: ResourceRight
}

export interface BookingRow extends Timestamps {
  id: number
  resource_id: number
  requester_id: number
  /** UTC ISO 8601 with milliseconds, so rows compare as strings. */
  start_at: string
  end_at: string
  status: BookingStatus
  approver_id: number | null
  decided_at: string | null
  /** Collection of the booker's event as the booker sees it: '/<sub>/<name>/', or a share name. */
  event_calendar_path: string
  event_uid: string
  /** Opaque random id the availability block carries instead of the calendar path or UID. */
  block_ref: string
  /** Set while the booking event cannot be found; the status stays as it was. */
  orphaned_at: string | null
  reconcile_attempts: number
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
  /** The order the user keeps the sidebar's sections in (FR-21), complete; null means the default. */
  sidebarOrder: SidebarSectionId[] | null
}
