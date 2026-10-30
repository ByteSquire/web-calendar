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
