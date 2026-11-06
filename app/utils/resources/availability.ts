// Resources from the API as sidebar entries, and their availability as calendar entries (FR-18).
// A resource is shown through a calendar of type `resource` with the id `res:<id>`, as in the mock
// data: that calendar takes part in visibility and colours like any other, but the loader never
// reads it from CalDAV. Pure functions, no Vue.
import type { Calendar, CalendarEvent, CalendarResource } from '../../../shared/types/calendar'
import {
  MAX_AVAILABILITY_RANGE_DAYS,
  type AvailabilityEntry,
  type AvailabilityResponse,
} from '../../../shared/types/resources-api'
import { BUSY_TITLE } from '../event-display'
import { N_, t, tv } from '../i18n'
import type { ApiCalendarPref } from '../live/api-types'
import { normalizeHexColor, paletteColor } from '../live/palette'
import { wallClockOf } from './slot'
import type { ApiResource } from './types'

export const RESOURCE_CALENDAR_PREFIX = 'res:'
const ENTRY_ID_PREFIX = 'avail:'
const DAY_MS = 24 * 60 * 60 * 1000

export const resourceCalendarId = (apiId: number | string) => `${RESOURCE_CALENDAR_PREFIX}${apiId}`

export function isResourceCalendarId(id: string): boolean {
  return id.startsWith(RESOURCE_CALENDAR_PREFIX)
}

/** The API id of `res:<id>`, or null. */
export function apiIdOfResourceCalendar(id: string): number | null {
  const match = /^res:([1-9][0-9]{0,14})$/.exec(id)
  return match ? Number(match[1]) : null
}

/**
 * The resources as calendars of the sidebar. The colour is the viewer's (`/api/calendar-prefs`,
 * `res:<id>`) when they chose one, else the palette's by position, which is the resource's own.
 */
export function toResourceCalendars(
  list: readonly ApiResource[],
  prefs: readonly Pick<ApiCalendarPref, 'ref' | 'color'>[] = [],
): Calendar[] {
  const colors = new Map(prefs.map((pref) => [pref.ref, pref.color]))
  return list.map((resource, index) => {
    const id = resourceCalendarId(resource.id)
    const ownColor = paletteColor(index)
    return {
      id,
      name: resource.name,
      type: 'resource',
      color: normalizeHexColor(colors.get(id)) ?? ownColor,
      ownColor,
      defaultVisible: false,
      resourceType: resource.type,
      readOnly: true,
    }
  })
}

export function toCalendarResources(list: readonly ApiResource[]): CalendarResource[] {
  return list.map((resource) => ({
    id: String(resource.id),
    calendarId: resourceCalendarId(resource.id),
    name: resource.name,
    type: resource.type,
    ...(resource.location ? { location: resource.location } : {}),
    ...(resource.capacity !== null ? { capacity: resource.capacity } : {}),
  }))
}

/**
 * `[from, to)` cut into pieces the availability route accepts (it answers at most 62 days).
 * A year view needs six requests; `maxPieces` keeps a runaway range from sending more.
 */
export function availabilityRanges(
  start: Date,
  end: Date,
  maxPieces = 8,
): { from: string; to: string }[] {
  const pieces: { from: string; to: string }[] = []
  const step = MAX_AVAILABILITY_RANGE_DAYS * DAY_MS
  for (
    let from = start.getTime();
    from < end.getTime() && pieces.length < maxPieces;
    from += step
  ) {
    pieces.push({
      from: new Date(from).toISOString(),
      to: new Date(Math.min(from + step, end.getTime())).toISOString(),
    })
  }
  return pieces
}

export interface AvailabilityContext {
  displayTimeZone: string
  /** The title of an event the browser has already loaded, by its UID. */
  titleOf: (eventUid: string) => string | undefined
}

export const BUSY_PENDING_TITLE = N_('Busy (pending)')

function entryTitle(entry: AvailabilityEntry, context: AvailabilityContext) {
  const known = entry.eventUid ? context.titleOf(entry.eventUid) : undefined
  const name = entry.requesterName
  if (known)
    return { title: known, description: name ? t('Booked by {name}', { name }) : undefined }
  return {
    title: name ? t('Booked by {name}', { name }) : t('Booked'),
    description: undefined,
  }
}

/**
 * One calendar entry per booking. Approved bookings block; pending ones are a hint and use the
 * tentative look. A blocked entry (the caller may not see the details) is the existing hatched
 * "Busy" entry when approved; when pending it is a plain tentative entry titled `Busy (pending)`,
 * because the hatched look has no tentative variant.
 */
export function availabilityToEvents(
  response: AvailabilityResponse,
  context: AvailabilityContext,
): CalendarEvent[] {
  const events: CalendarEvent[] = []
  for (const resource of response.resources) {
    const calendarId = resourceCalendarId(resource.resourceId)
    for (const entry of resource.entries) {
      const pending = entry.status === 'pending'
      const base = {
        id: `${ENTRY_ID_PREFIX}${entry.bookingId}`,
        uid: `avail-${entry.bookingId}`,
        calendarId,
        start: wallClockOf(entry.start, context.displayTimeZone),
        end: wallClockOf(entry.end, context.displayTimeZone),
        allDay: false,
        categoryIds: [],
        resourceId: String(resource.resourceId),
      }
      if (entry.blocked) {
        events.push(
          pending
            ? { ...base, title: tv(BUSY_PENDING_TITLE), status: 'tentative' }
            : { ...base, title: tv(BUSY_TITLE), status: 'confirmed', isBlocked: true },
        )
        continue
      }
      const { title, description } = entryTitle(entry, context)
      events.push({
        ...base,
        title,
        status: pending ? 'tentative' : 'confirmed',
        ...(description ? { description } : {}),
      })
    }
  }
  return events
}
