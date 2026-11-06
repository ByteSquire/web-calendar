// Read results -> CalendarEvent[]: runs the iCalendar reader over what a calendar returned and
// reports problems per calendar (NFR-4: one calendar failing never takes the others down).
import type { CalendarEvent } from '../../../shared/types/calendar'
import type { DavObject } from '../caldav/types'
import { readFreeBusyEvents } from '../ical/free-busy'
import { readCalendarObject } from '../ical/read'
import type { ReadIssue, ReadOptions } from '../ical/read-types'
import { isExternalRef } from './calendars'
import { describeLoadError, isAborted, isPasswordError } from './errors'

export interface ReadContext {
  displayTimeZone: string
  orgTimeZone: string
  /** Only events overlapping `[start, end)` are returned. */
  range: { start: Date; end: Date }
}

/** What fetching one calendar produced: its objects (CalDAV), its text (subscription) or a failure. */
export type CalendarOutcome =
  | {
      kind: 'caldav'
      calendarId: string
      objects: readonly DavObject[]
      /**
       * The reader expands the series: on for the built-in service and the external accounts, whose
       * objects are read as stored. Off only for objects a server already expanded.
       */
      expandRecurrence?: boolean
    }
  | { kind: 'ical'; calendarId: string; text: string }
  /** The VFREEBUSY of a free/busy share: "Busy" blocks, nothing else of the events. */
  | { kind: 'free-busy'; calendarId: string; text: string }
  | { kind: 'failed'; calendarId: string; error: unknown }

export interface CalendarReadResult {
  calendarId: string
  events: CalendarEvent[]
  /** Short message when the calendar could not be loaded; null when it was. */
  error: string | null
  /** The failure is one a new password for an external account may cure. */
  needsPassword: boolean
  /** The load was cancelled; the result says nothing about the calendar. */
  aborted: boolean
  /** Parts of the data that could not be read and were left out. */
  skipped: number
  /** Things read anyway with an assumption (for example an unknown time zone name). */
  warnings: number
}

function countIssues(issues: readonly ReadIssue[]): { skipped: number; warnings: number } {
  let warnings = 0
  for (const issue of issues) if (issue.severity === 'warning') warnings++
  return { skipped: issues.length - warnings, warnings }
}

/**
 * Keeps the first of events with the same id. Ids include the calendar, the resource and the
 * occurrence, so a repeat is the same occurrence delivered twice (a server listing an object twice,
 * a feed repeating a component).
 */
export function dedupeEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>()
  const unique: CalendarEvent[] = []
  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    unique.push(event)
  }
  return unique
}

/**
 * The events of one calendar. A calendar that failed gives no events and a message. Read problems
 * (`ReadIssue`) never fail the calendar: they are counted so the UI can say that some entries
 * could not be shown.
 */
export function readCalendarEvents(
  outcome: CalendarOutcome,
  context: ReadContext,
): CalendarReadResult {
  const { calendarId } = outcome
  const base = {
    calendarId,
    events: [],
    error: null,
    needsPassword: false,
    aborted: false,
    skipped: 0,
    warnings: 0,
  }
  if (outcome.kind === 'failed') {
    return isAborted(outcome.error)
      ? { ...base, aborted: true }
      : {
          ...base,
          error: describeLoadError(outcome.error),
          needsPassword: isPasswordError(outcome.error),
        }
  }

  if (outcome.kind === 'free-busy') {
    // The query was padded by a day at each end, like the others; only what overlaps is kept.
    const { events, skipped } = readFreeBusyEvents(outcome.text, {
      calendarId,
      displayTimeZone: context.displayTimeZone,
      range: context.range,
    })
    return { ...base, events, skipped }
  }

  const common = {
    calendarId,
    displayTimeZone: context.displayTimeZone,
    orgTimeZone: context.orgTimeZone,
    range: context.range,
  }
  const events: CalendarEvent[] = []
  const issues: ReadIssue[] = []
  const take = (options: ReadOptions, data: string) => {
    const read = readCalendarObject(data, options)
    events.push(...read.events)
    issues.push(...read.errors)
  }

  if (outcome.kind === 'caldav') {
    for (const object of outcome.objects) {
      // The server expanded the series (REPORT with `expand`): every VEVENT is one occurrence.
      take(
        {
          ...common,
          href: object.url,
          ...(object.etag !== '' ? { etag: object.etag } : {}),
          expandRecurrence: outcome.expandRecurrence ?? false,
          // Only the built-in service may claim a booking: an external server or a feed could not
          // be trusted with one.
          trustBookingProperties: !isExternalRef(calendarId),
        },
        object.data,
      )
    }
  } else {
    // A subscription is one plain feed: the reader expands its recurrences. It has no resource
    // URL, so its events carry no href or ETag (nothing can be written back).
    take({ ...common, href: '', expandRecurrence: true }, outcome.text)
    for (const event of events) {
      delete event.href
      delete event.etag
    }
  }

  return { ...base, events: dedupeEvents(events), ...countIssues(issues) }
}
