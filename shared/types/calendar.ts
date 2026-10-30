// Domain types shared by the UI and (later) the Nitro API.

export type CalendarType = 'caldav' | 'ical' | 'resource'

export type ResourceType = 'room' | 'car' | 'equipment'

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'

export type ViewIcon = 'calendar' | 'users' | 'layers' | 'shield' | 'star'

export interface CalendarUser {
  id: string
  /** OIDC subject; stable user key (design §5). */
  oidcSub?: string
  name: string
  email: string
  lastLoginAt?: string
}

export interface Calendar {
  /**
   * For live calendars the calendar's ref: `dav:<collection path>` for the built-in service
   * (for example `dav:/caldav/<sub>/<uuid>/`), `ics:<subscription id>` for an iCal subscription,
   * `ext:<account id>:<collection url>` for an external CalDAV account. The same string is
   * `calendar_prefs.calendar_ref` and the refs in `views.definition`.
   */
  id: string
  name: string
  type: CalendarType
  color: string
  /** Initial sidebar toggle state. */
  defaultVisible: boolean
  ownerId?: string
  sourceUrl?: string
  caldavAccountId?: string
  /** Set when `type` is `resource`. */
  resourceType?: ResourceType
  /** The CalDAV collection URL (a path for the built-in service). */
  href?: string
  /** The viewer may not change events here (subscriptions, read-only shares). */
  readOnly?: boolean
}

export interface CalendarResource {
  id: string
  /** The resource's own calendar. */
  calendarId: string
  name: string
  type: ResourceType
  location?: string
  capacity?: number
}

export interface Category {
  id: string
  name: string
  color: string
}

export type FilterKind = 'text' | 'category' | 'status'

export interface CalendarFilter {
  id: string
  name: string
  kind: FilterKind
  value: string
}

export interface CalendarView {
  id: string
  name: string
  icon: ViewIcon
  /** Parsed `views.definition`: calendars in scope. */
  calendarIds: string[]
  isAdmin: boolean
  ownerId?: string
}

export interface CalendarEvent {
  id: string
  calendarId: string
  /** iCal UID (unique per calendar). */
  uid: string
  title: string
  /** ISO 8601 date (all-day) or local date-time (timed). */
  start: string
  /** ISO 8601; exclusive for all-day events. */
  end: string
  allDay: boolean
  status: EventStatus
  description?: string
  location?: string
  categoryIds: string[]
  /** Set when the event books a resource. */
  resourceId?: string
  /** Calendar that created a resource booking. */
  bookedByCalendarId?: string
  /** Details hidden by ACL; render as free/busy (FR-18). */
  isBlocked?: boolean
  /** CalDAV ETag for sync (design §5/§7). */
  etag?: string
  /** Last modification time from the source (ISO 8601). */
  lastModified?: string
  /** URL of the CalDAV resource (an .ics file) that holds the event; set for CalDAV events. */
  href?: string
  /**
   * Identifies one occurrence of a recurring event: the original start as a UTC instant
   * (`2026-10-26T08:00:00Z`), or a date (`2026-11-05`) for an all-day series. Absent for single events.
   */
  recurrenceId?: string
  /** Part of a recurring series (also for single occurrences that were changed). */
  recurring?: boolean
  /** The names in the iCal `CATEGORIES`; `categoryIds` are resolved from them by the app. */
  categoryNames?: string[]
}
