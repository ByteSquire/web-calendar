// Domain types shared by the UI and (later) the Nitro API.

export type CalendarType = 'caldav' | 'ical' | 'resource'

export type ResourceType = 'room' | 'car' | 'equipment'

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'

export type ViewIcon = 'calendar' | 'users' | 'layers' | 'shield' | 'star'

export interface CalendarUser {
  id: string
  name: string
  email: string
}

export interface Calendar {
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
  /** Calendars in scope for this view. */
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
}
