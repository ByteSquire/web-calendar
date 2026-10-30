// Types of the iCalendar reader (`readCalendarObject` in read.ts).
import type { CalendarEvent } from '../../../shared/types/calendar'

export interface ReadOptions {
  /** Goes into `CalendarEvent.calendarId`. */
  calendarId: string
  /** URL path of the .ics resource (`CalendarEvent.href`). */
  href: string
  etag?: string
  /** The viewer's zone; the wall-clock strings of the events are in it. */
  displayTimeZone: string
  /** The zone floating times are read in. */
  orgTimeZone: string
  /** Only events that overlap [start, end) are returned. */
  range: { start: Date; end: Date }
  /**
   * false: the data is already expanded by the server (Radicale `expand`), every VEVENT is one
   * occurrence. true: expand RRULE, RDATE and EXDATE here. Default true.
   */
  expandRecurrence?: boolean
  /**
   * Bounds endless rules: the most occurrences of one series looked at between the start and the
   * end of the range (padded a little). Past that the rest is left out and `errors` says so.
   * Default 2000.
   */
  maxOccurrencesPerSeries?: number
}

export interface ReadIssue {
  /** The UID of the component the message is about, when it has one. */
  uid?: string
  message: string
  /**
   * `warning`: the component was read anyway (an unknown TZID read as organization time).
   * Absent: the component, or the part of it named in the message, was left out.
   */
  severity?: 'warning'
}

export interface ReadResult {
  events: CalendarEvent[]
  errors: ReadIssue[]
}
