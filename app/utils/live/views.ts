// Server views (`/api/views`) -> the state's views, and the filters from `/api/filters`.
import type { CalendarFilter, CalendarView, ViewIcon } from '../../../shared/types/calendar'
import type { ApiFilter, ApiView } from './api-types'

const ICONS: readonly ViewIcon[] = ['calendar', 'users', 'layers', 'shield', 'star']

const isViewIcon = (value: string): value is ViewIcon =>
  (ICONS as readonly string[]).includes(value)

/**
 * `calendarIds` are the refs of the view. Refs of calendars that are not there (deleted, not
 * shared with the viewer) stay in the list; `calendarIdsForView` drops them when the view is
 * selected. The colour a view may set per calendar has no place in `CalendarView` and is not used.
 */
export function toViews(views: readonly ApiView[]): CalendarView[] {
  // Phase 3 (FR-8): an admin-defined shared view must not reference an external account
  // (`ext:<account>:<url>`): admins must not steer users' external credentials. The rule belongs on
  // the server, where views are written (`readCalendarRef` in server/utils/api/validation.ts and
  // the admin path of server/utils/api/views.ts: refuse `ext:` refs there; in a user's own views
  // they must name one of the user's own account ids). The browser only displays what it is given.
  return views.map((view) => ({
    id: String(view.id),
    name: view.name,
    icon: isViewIcon(view.icon) ? view.icon : 'calendar',
    calendarIds: view.calendars.map((calendar) => calendar.ref),
    isAdmin: view.isAdmin,
    ...(view.ownerId !== null ? { ownerId: String(view.ownerId) } : {}),
  }))
}

export function toFilters(filters: readonly ApiFilter[]): CalendarFilter[] {
  return filters.map((filter) => ({
    id: String(filter.id),
    name: filter.name,
    kind: filter.kind,
    value: filter.value,
  }))
}
