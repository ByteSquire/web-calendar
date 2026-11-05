// Text for one event: the "when" line, status labels, the assistive label used by calendar entries
// and the detail model of the event sheet. Pure and without Nuxt, so it runs in plain Vitest
// (tests/fullcalendar.test.ts). Event times are wall-clock strings in the viewer's display zone (FR-29).
import { Temporal } from 'temporal-polyfill'
import type {
  Calendar,
  CalendarEvent,
  CalendarResource,
  Category,
  EventStatus,
  ResourceType,
} from '../../shared/types/calendar'
import { monthShort, weekdayShort } from './date-names'
import { N_, t, tv } from './i18n'
import { convertEventTimes } from './time-zone'

/** Title shown instead of the real one when the details are hidden by access rules (FR-18). */
export const BUSY_TITLE = N_('Busy')

export const STATUS_LABELS = {
  confirmed: N_('Confirmed'),
  tentative: N_('Tentative'),
  cancelled: N_('Cancelled'),
} satisfies Record<EventStatus, string>

const pad = (value: number) => String(value).padStart(2, '0')

/** `Wed, 28 Oct 2026`. */
export function formatEventDate(date: Temporal.PlainDate): string {
  return t('{weekday}, {day} {month} {year}', {
    weekday: weekdayShort(date.dayOfWeek),
    day: date.day,
    month: monthShort(date.month),
    year: date.year,
  })
}

const formatTime = (time: Temporal.PlainDateTime) => `${pad(time.hour)}:${pad(time.minute)}`

export interface EventWhen {
  /** `Wed, 28 Oct 2026`, or `Wed, 28 Oct 2026 – Fri, 30 Oct 2026` for several all-day dates. */
  date: string
  /** `All day`, `09:00`, `09:00 – 09:30` or `22:00 – Thu, 29 Oct 2026, 02:00`. */
  time: string
}

/**
 * The date and time of an event, all-day aware. `joiner` separates the two ends of a range: the
 * visible text uses an en dash, the assistive label the word "to".
 */
export function describeEventWhen(
  event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>,
  joiner = '–',
): EventWhen {
  if (event.allDay) {
    const first = Temporal.PlainDate.from(event.start.slice(0, 10))
    const endExclusive = Temporal.PlainDate.from(event.end.slice(0, 10))
    const last =
      Temporal.PlainDate.compare(endExclusive, first) > 0
        ? endExclusive.subtract({ days: 1 })
        : first
    const date = last.equals(first)
      ? formatEventDate(first)
      : `${formatEventDate(first)} ${joiner} ${formatEventDate(last)}`
    return { date, time: t('All day') }
  }

  const start = Temporal.PlainDateTime.from(event.start.slice(0, 19))
  const end = Temporal.PlainDateTime.from(event.end.slice(0, 19))
  const date = formatEventDate(start.toPlainDate())
  if (Temporal.PlainDateTime.compare(end, start) <= 0) return { date, time: formatTime(start) }

  const startDate = start.toPlainDate()
  const endDate = end.toPlainDate()
  if (endDate.equals(startDate)) {
    return { date, time: `${formatTime(start)} ${joiner} ${formatTime(end)}` }
  }
  // An event that ends at midnight belongs to the day it starts on.
  const endsAtMidnight =
    end.hour === 0 && end.minute === 0 && endDate.equals(startDate.add({ days: 1 }))
  if (endsAtMidnight) return { date, time: `${formatTime(start)} ${joiner} 24:00` }
  return {
    date,
    time: `${formatTime(start)} ${joiner} ${formatEventDate(endDate)}, ${formatTime(end)}`,
  }
}

/** `Wed, 28 Oct 2026, 09:00 to 09:30`: one line for screen readers. */
export function describeEventWhenInWords(
  event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>,
): string {
  const when = describeEventWhen(event, t('to'))
  return `${when.date}, ${when.time}`
}

/**
 * Accessible name of a calendar entry: title, date and time, calendar, and the status when it is
 * not the usual one. Blocked events give the time only, unless `nameBlocked`: the busy times of a
 * calendar the viewer has in the sidebar ("Busy times only"), whose name is no secret.
 */
export function eventAssistiveLabel(
  event: Pick<CalendarEvent, 'title' | 'start' | 'end' | 'allDay' | 'status' | 'isBlocked'>,
  calendarName: string | undefined,
  options: { nameBlocked?: boolean } = {},
): string {
  const parts = [event.isBlocked ? tv(BUSY_TITLE) : event.title, describeEventWhenInWords(event)]
  if (!event.isBlocked || options.nameBlocked) {
    if (calendarName) parts.push(t('Calendar {name}', { name: calendarName }))
    if (event.status !== 'confirmed') parts.push(tv(STATUS_LABELS[event.status]).toLowerCase())
  }
  return parts.join(', ')
}

export interface EventDetailsLookups {
  calendarById: ReadonlyMap<string, Calendar>
  categoryById: ReadonlyMap<string, Category>
  resourceById: ReadonlyMap<string, CalendarResource>
}

export interface EventDetails {
  id: string
  /** `Busy` for blocked events. */
  title: string
  blocked: boolean
  allDay: boolean
  when: EventWhen
  /**
   * The same time in the organization zone, when the viewer's zone differs from it and the event
   * has a time of day (FR-29). Null otherwise.
   */
  orgWhen: EventWhen | null
  status: EventStatus
  statusLabel: string
  /** Null for unknown calendars and blocked events, except the busy times of a calendar. */
  calendar: { name: string; color: string } | null
  location: string | null
  resource: { name: string; type: ResourceType; location: string | null } | null
  /** Name of the calendar that booked the resource, when known. */
  bookedBy: string | null
  description: string | null
  categories: { id: string; name: string; color: string }[]
}

/** The viewer's display zone and the organization zone, both IANA names. */
export interface EventZones {
  display: string
  org: string
}

/** What the event sheet shows. A blocked event reveals nothing but "Busy" and the time. */
export function buildEventDetails(
  event: CalendarEvent,
  lookups: EventDetailsLookups,
  zones?: EventZones,
): EventDetails {
  const base = {
    id: event.id,
    allDay: event.allDay,
    when: describeEventWhen(event),
    orgWhen:
      zones && !event.allDay && zones.display !== zones.org
        ? describeEventWhen(convertEventTimes(event, zones.display, zones.org))
        : null,
    status: event.status,
    statusLabel: tv(STATUS_LABELS[event.status]),
  }
  if (event.isBlocked) {
    // The busy times of a calendar the viewer has ("Busy times only") may name it; a resource's
    // blocked time never names the calendar that booked it.
    const own = lookups.calendarById.get(event.calendarId)
    return {
      ...base,
      title: tv(BUSY_TITLE),
      blocked: true,
      calendar: own?.freeBusyOnly ? { name: own.name, color: own.color } : null,
      location: null,
      resource: null,
      bookedBy: null,
      description: null,
      categories: [],
    }
  }

  const calendar = lookups.calendarById.get(event.calendarId)
  const resource = event.resourceId ? lookups.resourceById.get(event.resourceId) : undefined
  const bookedBy = event.bookedByCalendarId
    ? lookups.calendarById.get(event.bookedByCalendarId)
    : undefined
  return {
    ...base,
    title: event.title,
    blocked: false,
    calendar: calendar ? { name: calendar.name, color: calendar.color } : null,
    location: event.location || null,
    resource: resource
      ? { name: resource.name, type: resource.type, location: resource.location ?? null }
      : null,
    bookedBy: bookedBy?.name ?? null,
    description: event.description || null,
    categories: event.categoryIds.flatMap((id) => {
      const category = lookups.categoryById.get(id)
      return category ? [{ id, name: category.name, color: category.color }] : []
    }),
  }
}
