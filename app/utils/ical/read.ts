// iCalendar text -> CalendarEvent[] (FR-3..FR-13 read side, FR-28 recurrence, FR-29 time zones).
// Runs in the browser on the raw `.ics` that CalDAV (REPORT) or an iCal subscription returned.
//
// What matters here:
// - A bad component never takes the others down (NFR-4): every VEVENT is read on its own and what
//   goes wrong is reported in `errors`. The same holds when ical.js refuses the whole text: the
//   VEVENT and VTIMEZONE blocks are then parsed one by one.
// - Times are read in the zone they were written in (UTC, TZID, or organization time for floating
//   values; a VTIMEZONE of the file wins over the runtime's zone database) and only then shown in
//   the display zone. A recurrence rule runs in DTSTART's zone, so a weekly 09:00 Berlin meeting
//   follows Berlin's daylight saving whatever zone the viewer is in. All-day events are dates and
//   never move.
// - Only the occurrences that touch the requested range are built; a series that began years ago
//   is not walked from its beginning (see read-recur.ts).
import ICAL from 'ical.js'
import type { EventStatus } from '../../../shared/types/calendar'
import {
  isValidTimeZone,
  resolveDisplayTimeZone,
  resolveTimeZone,
} from '../../../shared/utils/time-zone'
import { RecurrenceError, ruleWalls } from './read-recur'
import type { ReadIssue, ReadOptions, ReadResult } from './read-types'
import { parseBookingMarks, type BookingMarks, type ReadEvent } from './x-properties'
import { zoneFromVtimezone } from './read-vtimezone'
import { issue, messageOf, parseIcs } from './read-parse'
import {
  DAY_MS,
  UTC_ZONE,
  type ZoneRules,
  formatUtcInstant,
  formatWall,
  formatWallDate,
  ianaZone,
  instantToWall,
  parseWall,
  wallFromFields,
  wallToInstant,
} from './zone'

const DEFAULT_MAX_OCCURRENCES = 2000
/** Occurrences before the range that may be walked when a rule cannot be started near the range. */
const MAX_SKIPPED_OCCURRENCES = 50_000
/** Slack around the range when picking occurrences from wall times (daylight saving, all-day). */
const WINDOW_SLACK_MS = 2 * DAY_MS

/** A defect in one component; the component is left out and the message goes to `errors`. */
class ComponentError extends Error {}

/** A DATE, or a wall time with the zone it is written in. */
type Stamp = { allDay: true; day: number } | { allDay: false; wall: number; zone: ZoneRules }

/** How long an event lasts: whole days as written (nominal) plus exact milliseconds. */
interface Length {
  days: number
  ms: number
}

interface Fields {
  uid: string
  title: string
  description?: string
  location?: string
  status: EventStatus
  categoryNames: string[]
  lastModified?: string
  bookingMarks?: BookingMarks
}

/** One occurrence in the display zone, with the instants used for range checks and ordering. */
interface Span {
  allDay: boolean
  startInstant: number
  endInstant: number
  start: string
  end: string
}

interface Reader {
  options: ReadOptions
  org: ZoneRules
  display: ZoneRules
  rangeStart: number
  rangeEnd: number
  maxOccurrences: number
  expand: boolean
  /** More than one UID in the resource (a subscription feed): ids then include the UID. */
  multiUid: boolean
  /** VTIMEZONE components of the file by TZID. */
  vtimezones: Map<string, ICAL.Component>
  zones: Map<string, { zone: ZoneRules; known: boolean }>
  warned: Set<string>
  errors: ReadIssue[]
}

const floorDay = (wall: number): number => Math.floor(wall / DAY_MS) * DAY_MS

// --- zones ------------------------------------------------------------------------------------

/** The IANA name a TZID stands for, or null. Handles libical's `/vendor/version/Europe/Berlin`. */
function ianaName(tzid: string): string | null {
  if (isValidTimeZone(tzid)) return tzid
  if (!tzid.startsWith('/')) return null
  const parts = tzid.split('/').filter(Boolean)
  for (const count of [3, 2, 1]) {
    const name = parts.slice(-count).join('/')
    if (parts.length >= count && isValidTimeZone(name)) return name
  }
  return null
}

/**
 * The zone a value is written in: the file's own VTIMEZONE, else the IANA zone of that name, else
 * (with a warning) the organization zone.
 */
function zoneOf(reader: Reader, tzid: string | undefined, uid: string | undefined): ZoneRules {
  if (!tzid) return reader.org
  let entry = reader.zones.get(tzid)
  if (!entry) {
    let zone: ZoneRules | null = null
    const component = reader.vtimezones.get(tzid)
    if (component) zone = zoneFromVtimezone(component)
    if (!zone) {
      const name = ianaName(tzid)
      if (name) zone = ianaZone(name)
    }
    entry = zone ? { zone, known: true } : { zone: reader.org, known: false }
    reader.zones.set(tzid, entry)
  }
  if (!entry.known) {
    const key = `${uid ?? ''}\u0000${tzid}`
    if (!reader.warned.has(key)) {
      reader.warned.add(key)
      report(reader, uid, `Unknown time zone "${tzid}"; read as organization time`, 'warning')
    }
  }
  return entry.zone
}

function report(
  reader: Reader,
  uid: string | undefined,
  message: string,
  severity?: 'warning',
): void {
  reader.errors.push(issue(uid, message, severity))
}

// --- values -----------------------------------------------------------------------------------

// ical.js reads `RECURRENCE-ID:20261105` (a date without VALUE=DATE, which is what Radicale's expand
// writes for an all-day series) as a date-time and leaves `2026-11-05T::` of it.
const DATE_AS_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T::$/

function stampOf(text: unknown, tzid: string | undefined, reader: Reader, uid: string): Stamp {
  const parsed = typeof text === 'string' ? parseWall(text.replace(DATE_AS_DATE_TIME, '$1')) : null
  if (!parsed) throw new ComponentError(`Invalid date or time ${JSON.stringify(text)}`)
  if (!parsed.hasTime) return { allDay: true, day: parsed.wall }
  if (parsed.utc) return { allDay: false, wall: parsed.wall, zone: UTC_ZONE }
  return { allDay: false, wall: parsed.wall, zone: zoneOf(reader, tzid, uid) }
}

function tzidOf(property: ICAL.Property): string | undefined {
  const value = property.getParameter('tzid')
  const tzid = Array.isArray(value) ? value[0] : value
  return typeof tzid === 'string' && tzid ? tzid : undefined
}

/** The value of a single-valued date or date-time property (DTSTART, DTEND, RECURRENCE-ID, ...). */
function stampOfProperty(property: ICAL.Property, reader: Reader, uid: string): Stamp {
  return stampOf(property.jCal[3], tzidOf(property), reader, uid)
}

const wallOfStamp = (stamp: Stamp): number => (stamp.allDay ? stamp.day : stamp.wall)
const zoneOfStamp = (stamp: Stamp): ZoneRules => (stamp.allDay ? UTC_ZONE : stamp.zone)
const instantOfStamp = (stamp: Stamp): number =>
  stamp.allDay ? stamp.day : wallToInstant(stamp.wall, stamp.zone)

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

function parseDuration(text: unknown, allDay: boolean): Length {
  const match = typeof text === 'string' ? DURATION.exec(text) : null
  // `P` and `PT` alone match the pattern but say nothing.
  if (!match || !/\d/.test(text as string)) {
    throw new ComponentError(`Invalid DURATION ${JSON.stringify(text)}`)
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match
  const wholeDays = Number(weeks ?? 0) * 7 + Number(days ?? 0)
  const ms = (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000
  // A negative duration cannot describe an event; it is read as no length.
  if (sign === '-') return allDay ? { days: 1, ms: 0 } : { days: 0, ms: 0 }
  if (allDay) return { days: Math.max(1, wholeDays + Math.ceil(ms / DAY_MS)), ms: 0 }
  return { days: wholeDays, ms }
}

/**
 * How long the event lasts. DTEND is exact; a DURATION counts weeks and days on the wall clock of
 * DTSTART's zone (RFC 5545 "nominal" days). Missing: one day when all-day, else no length.
 */
function lengthOf(vevent: ICAL.Component, start: Stamp, reader: Reader, uid: string): Length {
  const dtend = vevent.getFirstProperty('dtend')
  if (dtend) {
    const end = stampOfProperty(dtend, reader, uid)
    if (start.allDay) {
      const endDay = end.allDay ? end.day : floorDay(end.wall)
      return { days: Math.max(1, Math.round((endDay - start.day) / DAY_MS)), ms: 0 }
    }
    const startInstant = wallToInstant(start.wall, start.zone)
    const endInstant = end.allDay ? wallToInstant(end.day, start.zone) : instantOfStamp(end)
    if (endInstant < startInstant) {
      report(reader, uid, 'DTEND is before DTSTART; read as an event without length', 'warning')
      return { days: 0, ms: 0 }
    }
    return { days: 0, ms: endInstant - startInstant }
  }
  const duration = vevent.getFirstProperty('duration')
  if (duration) return parseDuration(duration.jCal[3], start.allDay)
  return start.allDay ? { days: 1, ms: 0 } : { days: 0, ms: 0 }
}

// --- spans ------------------------------------------------------------------------------------

function timedSpan(reader: Reader, startInstant: number, endInstant: number): Span {
  return {
    allDay: false,
    startInstant,
    endInstant,
    start: formatWall(instantToWall(startInstant, reader.display)),
    end: formatWall(instantToWall(endInstant, reader.display)),
  }
}

function daySpan(reader: Reader, startDay: number, endDay: number): Span {
  return {
    allDay: true,
    // Dates are shown where the viewer is, so that is where they start and end for range checks.
    startInstant: wallToInstant(startDay, reader.display),
    endInstant: wallToInstant(endDay, reader.display),
    start: formatWallDate(startDay),
    end: formatWallDate(endDay),
  }
}

/** The occurrence that starts at `wall` (in the zone of `start`) and lasts `length`. */
function spanAt(reader: Reader, start: Stamp, wall: number, length: Length): Span {
  if (start.allDay) return daySpan(reader, wall, wall + length.days * DAY_MS)
  const startInstant = wallToInstant(wall, start.zone)
  const endInstant =
    (length.days ? wallToInstant(wall + length.days * DAY_MS, start.zone) : startInstant) +
    length.ms
  return timedSpan(reader, startInstant, endInstant)
}

/** Overlap with [start, end); an event without length counts when it starts inside. */
function overlaps(reader: Reader, span: Span): boolean {
  if (span.startInstant >= reader.rangeEnd) return false
  if (span.endInstant > reader.rangeStart) return true
  return span.endInstant === span.startInstant && span.startInstant >= reader.rangeStart
}

// --- fields -----------------------------------------------------------------------------------

function textOf(vevent: ICAL.Component, name: string): string | undefined {
  const value = vevent.getFirstPropertyValue(name)
  return value === null || value === undefined ? undefined : String(value)
}

function statusOf(vevent: ICAL.Component): EventStatus {
  const status = (textOf(vevent, 'status') ?? '').trim().toUpperCase()
  if (status === 'CANCELLED' || status === 'CANCELED') return 'cancelled'
  if (status === 'TENTATIVE') return 'tentative'
  return 'confirmed'
}

function categoriesOf(vevent: ICAL.Component): string[] {
  const names: string[] = []
  for (const property of vevent.getAllProperties('categories')) {
    for (const value of property.getValues()) {
      const name = typeof value === 'string' ? value.trim() : ''
      if (name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

function fieldsOf(vevent: ICAL.Component, reader: Reader, uid: string): Fields {
  const fields: Fields = {
    uid,
    title: textOf(vevent, 'summary') ?? '',
    status: statusOf(vevent),
    categoryNames: categoriesOf(vevent),
  }
  const description = textOf(vevent, 'description')
  if (description !== undefined) fields.description = description
  const location = textOf(vevent, 'location')
  if (location !== undefined) fields.location = location
  if (reader.options.trustBookingProperties) {
    const marks = parseBookingMarks(
      textOf(vevent, 'x-web-calendar-resource'),
      textOf(vevent, 'x-web-calendar-booking'),
      textOf(vevent, 'x-web-calendar-booking-status'),
    )
    if (marks) fields.bookingMarks = marks
  }
  const modified = vevent.getFirstProperty('last-modified')
  if (modified) {
    try {
      const stamp = stampOfProperty(modified, reader, uid)
      if (!stamp.allDay) fields.lastModified = new Date(instantOfStamp(stamp)).toISOString()
    } catch {
      // A broken LAST-MODIFIED does not make the event unreadable.
    }
  }
  return fields
}

function makeEvent(
  reader: Reader,
  fields: Fields,
  span: Span,
  recurrenceId: string | undefined,
): ReadEvent {
  const { calendarId, href, etag } = reader.options
  const event: ReadEvent = {
    id: `${calendarId}|${href}|${recurrenceId ?? ''}${reader.multiUid ? `|${fields.uid}` : ''}`,
    calendarId,
    uid: fields.uid,
    title: fields.title,
    start: span.start,
    end: span.end,
    allDay: span.allDay,
    status: fields.status,
    categoryIds: [],
    categoryNames: [...fields.categoryNames],
    href,
    recurring: recurrenceId !== undefined,
  }
  if (fields.description !== undefined) event.description = fields.description
  if (fields.location !== undefined) event.location = fields.location
  if (etag !== undefined) event.etag = etag
  if (fields.lastModified !== undefined) event.lastModified = fields.lastModified
  if (fields.bookingMarks) event.bookingMarks = { ...fields.bookingMarks }
  if (recurrenceId !== undefined) event.recurrenceId = recurrenceId
  return event
}

/** The identity of a slot of a series: a UTC instant, or a date for an all-day series. */
const slotId = (stamp: Stamp): string =>
  stamp.allDay ? formatWallDate(stamp.day) : formatUtcInstant(instantOfStamp(stamp))

// --- one VEVENT as written --------------------------------------------------------------------

const hasRecurrence = (vevent: ICAL.Component): boolean =>
  vevent.hasProperty('rrule') || vevent.hasProperty('rdate')

function startOf(vevent: ICAL.Component, reader: Reader, uid: string): Stamp {
  const dtstart = vevent.getFirstProperty('dtstart')
  if (!dtstart) throw new ComponentError('Missing DTSTART')
  return stampOfProperty(dtstart, reader, uid)
}

/**
 * A VEVENT as one event: a single event, a recurrence override, an instance the server already
 * expanded, or (when expansion is off) a series master. Null when it lies outside the range.
 */
function readAsWritten(
  vevent: ICAL.Component,
  reader: Reader,
  uid: string,
): { event: ReadEvent; span: Span } | null {
  const start = startOf(vevent, reader, uid)
  const length = lengthOf(vevent, start, reader, uid)
  const span = spanAt(reader, start, wallOfStamp(start), length)
  if (!overlaps(reader, span)) return null
  const recurrenceProperty = vevent.getFirstProperty('recurrence-id')
  const recurrenceId = recurrenceProperty
    ? slotId(stampOfProperty(recurrenceProperty, reader, uid))
    : hasRecurrence(vevent)
      ? slotId(start)
      : undefined
  return { event: makeEvent(reader, fieldsOf(vevent, reader, uid), span, recurrenceId), span }
}

// --- series -----------------------------------------------------------------------------------

/** Slots taken out of a series: instants (timed) and days (all-day, or a date given for a time). */
interface Slots {
  instants: Set<number>
  days: Set<number>
}

function addSlot(slots: Slots, stamp: Stamp, seriesIsAllDay: boolean): void {
  if (stamp.allDay) slots.days.add(stamp.day)
  else {
    slots.instants.add(wallToInstant(stamp.wall, stamp.zone))
    if (seriesIsAllDay) slots.days.add(floorDay(stamp.wall))
  }
}

function hasSlot(slots: Slots, wall: number, instant: number, seriesIsAllDay: boolean): boolean {
  if (seriesIsAllDay) return slots.days.has(wall)
  return slots.instants.has(instant) || slots.days.has(floorDay(wall))
}

/** Every value of every EXDATE or RDATE property, with the TZID of its property. */
function* multiValues(
  vevent: ICAL.Component,
  name: string,
): Generator<{ value: unknown; tzid: string | undefined }> {
  for (const property of vevent.getAllProperties(name)) {
    const tzid = tzidOf(property)
    for (const value of property.jCal.slice(3)) yield { value, tzid }
  }
}

/**
 * The occurrences of a series master that touch the range (RRULE, RDATE, EXDATE; the slots of the
 * overrides are left out, the overrides themselves are read separately).
 */
function expandSeries(
  master: ICAL.Component,
  reader: Reader,
  uid: string,
  overrideSlots: Stamp[],
): { event: ReadEvent; span: Span }[] {
  const start = startOf(master, reader, uid)
  const length = lengthOf(master, start, reader, uid)
  const zone = zoneOfStamp(start)
  const startWall = wallOfStamp(start)
  const lengthMs = length.days * DAY_MS + length.ms

  // The window in which occurrences are looked at, as wall times in the series' zone. Instants
  // that are close to the range edges may map to either side, hence the slack.
  let from: number
  let to: number
  if (start.allDay) {
    from = instantToWall(reader.rangeStart, reader.display) - lengthMs - WINDOW_SLACK_MS
    to = instantToWall(reader.rangeEnd, reader.display) + WINDOW_SLACK_MS
  } else {
    from = instantToWall(reader.rangeStart - lengthMs - WINDOW_SLACK_MS, zone)
    to = instantToWall(reader.rangeEnd + WINDOW_SLACK_MS, zone)
  }

  // Candidates by start (instant for timed, day for all-day), so a date given twice counts once.
  const candidates = new Map<number, { wall: number; instant: number; length: Length }>()
  const consider = (wall: number, candidateLength: Length = length): void => {
    if (wall < from || wall > to) return
    const instant = start.allDay ? wall : wallToInstant(wall, zone)
    if (!candidates.has(instant))
      candidates.set(instant, { wall, instant, length: candidateLength })
  }
  consider(startWall)

  for (const property of master.getAllProperties('rrule')) {
    let rule: unknown
    try {
      rule = property.getFirstValue()
    } catch (error) {
      // ical.js refuses rules it cannot parse (an unknown FREQ, a number out of range).
      report(reader, uid, `Recurrence rule not used: ${messageOf(error)}`)
      continue
    }
    if (!(rule instanceof ICAL.Recur)) {
      report(reader, uid, 'Recurrence rule not used: RRULE is not a rule')
      continue
    }
    let looked = 0
    let skipped = 0
    try {
      const run = {
        rule,
        startWall,
        isDate: start.allDay,
        untilWall: untilWall(rule, start, zone),
        fromWall: from,
      }
      // ical.js moves 29 Feb to 1 Mar in the years without it; RFC 5545 §3.3.10 says such an
      // instance does not exist.
      const keepsDay =
        rule.freq === 'YEARLY' &&
        !['BYMONTHDAY', 'BYDAY', 'BYYEARDAY', 'BYWEEKNO'].some(
          (part) => rule.getComponent(part).length,
        )
      const startDay = new Date(startWall).getUTCDate()
      for (const wall of ruleWalls(run)) {
        if (wall > to) break
        if (keepsDay && new Date(wall).getUTCDate() !== startDay) continue
        if (wall < from) {
          if (++skipped > MAX_SKIPPED_OCCURRENCES) {
            throw new RecurrenceError('too many occurrences before the range')
          }
          continue
        }
        if (++looked > reader.maxOccurrences) {
          report(
            reader,
            uid,
            `Recurrence limit of ${reader.maxOccurrences} occurrences reached; later ones are left out`,
          )
          break
        }
        consider(wall)
      }
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error
      report(reader, uid, `Recurrence rule not used: ${error.message}`)
    }
  }

  for (const { value, tzid } of multiValues(master, 'rdate')) {
    try {
      if (Array.isArray(value)) {
        // PERIOD: start, then either an end or a duration.
        const first = stampOf(value[0], tzid, reader, uid)
        const second: unknown = value[1]
        const periodLength =
          typeof second === 'string' && second.includes('P')
            ? parseDuration(second, first.allDay)
            : {
                days: 0,
                ms: instantOfStamp(stampOf(second, tzid, reader, uid)) - instantOfStamp(first),
              }
        consider(rdateWall(first, start, zone), periodLength)
      } else {
        consider(rdateWall(stampOf(value, tzid, reader, uid), start, zone))
      }
    } catch (error) {
      if (!(error instanceof ComponentError)) throw error
      report(reader, uid, `RDATE not used: ${error.message}`)
    }
  }

  const excluded: Slots = { instants: new Set(), days: new Set() }
  for (const slot of overrideSlots) addSlot(excluded, slot, start.allDay)
  for (const { value, tzid } of multiValues(master, 'exdate')) {
    try {
      addSlot(excluded, stampOf(value, tzid, reader, uid), start.allDay)
    } catch (error) {
      if (!(error instanceof ComponentError)) throw error
      report(reader, uid, `EXDATE not used: ${error.message}`)
    }
  }

  const occurrences: { event: ReadEvent; span: Span }[] = []
  let fields: Fields | null = null
  for (const candidate of candidates.values()) {
    if (hasSlot(excluded, candidate.wall, candidate.instant, start.allDay)) continue
    const span = spanAt(reader, start, candidate.wall, candidate.length)
    if (!overlaps(reader, span)) continue
    fields ??= fieldsOf(master, reader, uid)
    const recurrenceId = start.allDay
      ? formatWallDate(candidate.wall)
      : formatUtcInstant(candidate.instant)
    occurrences.push({ event: makeEvent(reader, fields, span, recurrenceId), span })
  }
  return occurrences
}

/** An RDATE as a wall time in the series' zone. */
function rdateWall(value: Stamp, start: Stamp, zone: ZoneRules): number {
  if (start.allDay) return value.allDay ? value.day : floorDay(value.wall)
  // A DATE for a timed series keeps the time of day of DTSTART.
  if (value.allDay) return value.day + (start.wall - floorDay(start.wall))
  return value.zone === zone || value.zone.id === zone.id
    ? value.wall
    : instantToWall(wallToInstant(value.wall, value.zone), zone)
}

/**
 * UNTIL as a wall time in DTSTART's zone, which is what ical.js compares occurrences with: a UTC
 * UNTIL is moved into the zone, a date allows the whole last day.
 */
function untilWall(rule: ICAL.Recur, start: Stamp, zone: ZoneRules): number | null {
  const until = rule.until
  if (!until) return null
  const wall = wallFromFields(
    until.year,
    until.month,
    until.day,
    until.hour,
    until.minute,
    until.second,
  )
  if (wall === null) throw new RecurrenceError('UNTIL is not a valid date')
  if (start.allDay) return floorDay(wall)
  if (until.isDate) return floorDay(wall) + DAY_MS - 1000
  return until.zone?.tzid === 'UTC' ? instantToWall(wall, zone) : wall
}

// --- entry point ------------------------------------------------------------------------------

interface Group {
  masters: ICAL.Component[]
  overrides: ICAL.Component[]
}

function createReader(options: ReadOptions, errors: ReadIssue[]): Reader | null {
  const start = options.range?.start?.getTime()
  const end = options.range?.end?.getTime()
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    errors.push({ message: 'The range is not a valid pair of dates' })
    return null
  }
  const orgName = resolveTimeZone(options.orgTimeZone)
  const displayName = resolveDisplayTimeZone(options.displayTimeZone, orgName)
  if (orgName !== options.orgTimeZone) {
    errors.push(
      issue(
        undefined,
        `Unknown organization time zone "${options.orgTimeZone}"; using ${orgName}`,
        'warning',
      ),
    )
  }
  if (displayName !== options.displayTimeZone) {
    errors.push(
      issue(
        undefined,
        `Unknown display time zone "${options.displayTimeZone}"; using ${displayName}`,
        'warning',
      ),
    )
  }
  const max = options.maxOccurrencesPerSeries
  return {
    options,
    org: ianaZone(orgName),
    display: ianaZone(displayName),
    rangeStart: start,
    rangeEnd: end,
    maxOccurrences:
      max !== undefined && Number.isInteger(max) && max >= 1 ? max : DEFAULT_MAX_OCCURRENCES,
    expand: options.expandRecurrence !== false,
    multiUid: false,
    vtimezones: new Map(),
    zones: new Map(),
    warned: new Set(),
    errors,
  }
}

/**
 * The events of one `.ics` resource that touch `options.range`, with start and end as wall-clock
 * strings in the display zone (all-day: dates, end exclusive). Never throws for bad content: what
 * cannot be read is left out and listed in `errors`, the rest is returned.
 */
export function readCalendarObject(ics: string, options: ReadOptions): ReadResult {
  const errors: ReadIssue[] = []
  const found: { event: ReadEvent; span: Span }[] = []
  try {
    collectEvents(ics, options, errors, found)
  } catch (error) {
    // Nothing above should throw; this keeps one surprise from losing the events already read.
    errors.push({
      message: `Unexpected error while reading the calendar data: ${messageOf(error)}`,
    })
  }
  found.sort(
    (a, b) => a.span.startInstant - b.span.startInstant || a.span.endInstant - b.span.endInstant,
  )
  return { events: found.map((entry) => entry.event), errors }
}

function collectEvents(
  ics: string,
  options: ReadOptions,
  errors: ReadIssue[],
  found: { event: ReadEvent; span: Span }[],
): void {
  if (typeof ics !== 'string') {
    errors.push({ message: 'The calendar data is not text' })
    return
  }
  const reader = createReader(options, errors)
  if (!reader) return
  // Feeds served with a UTF-8 byte order mark would otherwise fail on their first line.
  const parsed = parseIcs(ics.charCodeAt(0) === 0xfeff ? ics.slice(1) : ics, errors)
  for (const vtimezone of parsed.vtimezones) {
    const tzid = textOf(vtimezone, 'tzid')
    if (tzid) reader.vtimezones.set(tzid, vtimezone)
  }

  const groups = new Map<string, Group>()
  for (const vevent of parsed.vevents) {
    const uid = textOf(vevent, 'uid')
    if (!uid) {
      errors.push({ message: 'Skipped a VEVENT without UID' })
      continue
    }
    let group = groups.get(uid)
    if (!group) groups.set(uid, (group = { masters: [], overrides: [] }))
    ;(vevent.hasProperty('recurrence-id') ? group.overrides : group.masters).push(vevent)
  }
  reader.multiUid = groups.size > 1

  const ids = new Set<string>()
  const add = (uid: string, read: () => { event: ReadEvent; span: Span }[] | null): void => {
    try {
      for (const entry of read() ?? []) {
        if (ids.has(entry.event.id)) {
          report(reader, uid, 'Skipped a duplicate of an event already read', 'warning')
        } else {
          ids.add(entry.event.id)
          found.push(entry)
        }
      }
    } catch (error) {
      report(reader, uid, messageOf(error))
    }
  }

  for (const [uid, group] of groups) {
    const expandable = reader.expand ? group.masters.filter(hasRecurrence) : []
    // Where the overrides sit in the series; their own times are read below.
    const overrideSlots: Stamp[] = []
    if (expandable.length) {
      for (const override of group.overrides) {
        try {
          const property = override.getFirstProperty('recurrence-id')
          if (property) overrideSlots.push(stampOfProperty(property, reader, uid))
        } catch {
          // Reported when the override itself is read.
        }
      }
    }
    for (const master of group.masters) {
      add(uid, () => {
        if (expandable.includes(master)) return expandSeries(master, reader, uid, overrideSlots)
        const one = readAsWritten(master, reader, uid)
        return one ? [one] : null
      })
    }
    for (const override of group.overrides) {
      add(uid, () => {
        const one = readAsWritten(override, reader, uid)
        return one ? [one] : null
      })
    }
  }
}
