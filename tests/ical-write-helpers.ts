// Helpers for the iCalendar write tests: expand a resource with ical.js the way an independent
// client would (VTIMEZONEs of the file registered, overrides related to their master), so a test can
// compare the occurrences before and after an edit without trusting the code under test.
import ICAL from 'ical.js'

export interface Occurrence {
  uid: string
  summary: string
  /** The start as a wall clock exactly as ical.js reports it (`2026-10-26T09:00:00[Z]`). */
  wall: string
  /** The start as a UTC instant; null for a floating time (it has none). */
  utc: string | null
  endUtc: string | null
  /** The occurrence's original slot, as ical.js names it. */
  recurrenceId: string
  isDate: boolean
}

function lineEnd(text: string): string {
  return text.endsWith('\r\n') ? text : `${text}\r\n`
}

/** All occurrences of the resource up to `limit`, in time order. */
export function expand(ics: string, limit = 500): Occurrence[] {
  ICAL.TimezoneService.reset()
  const root = new ICAL.Component(ICAL.parse(lineEnd(ics)))
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(vtimezone)
  }
  const events = root.getAllSubcomponents('vevent')
  // ical.js reads a TZID it does not know as a floating time; a test must never pass that way.
  for (const event of events) {
    for (const prop of event.getAllProperties()) {
      const tzid = prop.getParameter('tzid')
      if (typeof tzid === 'string' && !ICAL.TimezoneService.has(tzid)) {
        throw new Error(`The resource uses TZID ${tzid} but has no VTIMEZONE for it`)
      }
    }
  }
  const master = events.find((e) => !e.hasProperty('recurrence-id'))
  const overrides = events.filter((e) => e.hasProperty('recurrence-id'))
  const out: Occurrence[] = []
  const describe = (
    event: ICAL.Event,
    start: ICAL.Time,
    end: ICAL.Time,
    recurrenceId: ICAL.Time,
  ) => {
    const floating = start.zone.tzid === 'floating'
    out.push({
      uid: event.uid,
      summary: event.summary,
      wall: start.toString(),
      utc: floating ? null : start.toJSDate().toISOString(),
      endUtc: floating ? null : end.toJSDate().toISOString(),
      recurrenceId: recurrenceId.toString(),
      isDate: start.isDate,
    })
  }
  if (master) {
    const event = new ICAL.Event(master)
    for (const override of overrides) event.relateException(new ICAL.Event(override))
    if (!event.isRecurring()) {
      describe(event, event.startDate, event.endDate, event.startDate)
    } else {
      const iterator = event.iterator()
      for (let i = 0; i < limit; i++) {
        const next = iterator.next()
        if (!next) break
        const details = event.getOccurrenceDetails(next)
        describe(details.item, details.startDate, details.endDate, details.recurrenceId)
      }
    }
  } else {
    for (const override of overrides) {
      const event = new ICAL.Event(override)
      describe(event, event.startDate, event.endDate, event.recurrenceId)
    }
  }
  return out.sort((a, b) => (a.utc ?? a.wall).localeCompare(b.utc ?? b.wall))
}

/** `utc` instants (or walls for floating) of the occurrences, for comparing sets. */
export function instants(ics: string, limit = 500): string[] {
  return expand(ics, limit).map((o) => o.utc ?? o.wall)
}

/** The unfolded content lines of a resource (CRLF split, folds joined). */
export function contentLines(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, '')
    .split('\r\n')
    .filter((line) => line !== '')
}

/** The content lines of the first VEVENT without a RECURRENCE-ID (the master). */
export function masterLines(ics: string): string[] {
  const events = splitEvents(ics)
  return events.find((e) => !e.some((l) => l.startsWith('RECURRENCE-ID'))) ?? []
}

/** The content lines of every VEVENT, one array per event (BEGIN and END included). */
export function splitEvents(ics: string): string[][] {
  const events: string[][] = []
  let current: string[] | null = null
  for (const line of contentLines(ics)) {
    if (line === 'BEGIN:VEVENT') current = []
    if (current) current.push(line)
    if (line === 'END:VEVENT' && current) {
      events.push(current)
      current = null
    }
  }
  return events
}

export function wrapCalendar(body: string[], timezones: string[] = []): string {
  return (
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      ...timezones,
      ...body,
      'END:VCALENDAR',
    ].join('\r\n') + '\r\n'
  )
}

export const BERLIN_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]
