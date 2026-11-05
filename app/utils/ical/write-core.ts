// Steps shared by write.ts and write-create.ts: input checks, the parsed document, metadata,
// scalar changes, ranges and VTIMEZONE.
import {
  escapeText,
  firstProp,
  insertPropAfter,
  makeProp,
  parseDocument,
  props,
  rawValue,
  removeProps,
  replaceProps,
  splitTextList,
  subcomponents,
  unescapeText,
  withParams,
  withValue,
  type Comp,
} from './write-lines'
import { t } from '../i18n'
import { generateVTimezone } from './vtimezone'
import {
  EditError,
  type EventChanges,
  type EventStatusValue,
  type WallClockRange,
  type WriteContext,
} from './write-types'
import {
  dateAddDays,
  daysBetween,
  ianaNameOf,
  isDateWall,
  makeTimeProp,
  normalizeWall,
  readTime,
  sameInfo,
  toBasicUtc,
  wallAddSeconds,
  wallDiffSeconds,
  withTime,
  zoneNamed,
  ZoneResolver,
  type TimeInfo,
} from './write-zone'
import { isValidTimeZone } from '../../../shared/utils/time-zone'

// ---------------------------------------------------------------------------------------------
// Input checks

export function checkContext(ctx: WriteContext): void {
  for (const [name, zone] of [
    ['displayTimeZone', ctx.displayTimeZone],
    ['orgTimeZone', ctx.orgTimeZone],
  ] as const) {
    if (!isValidTimeZone(zone))
      throw new EditError(
        'invalid-input',
        name === 'displayTimeZone'
          ? t('The display time zone is not a time zone: {zone}', { zone })
          : t('The organisation time zone is not a time zone: {zone}', { zone }),
      )
  }
}

/** A range with both ends checked: dates for all-day, date-times otherwise, end not before start. */
export function parseRange(range: WallClockRange): WallClockRange {
  const start = normalizeWall(range.start, 'start')
  const end = normalizeWall(range.end, 'end')
  if (range.allDay) {
    if (!isDateWall(start) || !isDateWall(end)) {
      throw new EditError('invalid-input', t('An all-day event needs dates, not times.'))
    }
    if (end <= start) {
      throw new EditError(
        'invalid-input',
        t('An all-day event ends (exclusive) after the day it starts.'),
      )
    }
  } else {
    if (isDateWall(start) || isDateWall(end)) {
      throw new EditError('invalid-input', t('A timed event needs a start and an end time.'))
    }
    if (end < start) throw new EditError('invalid-input', t('The event ends before it starts.'))
  }
  return { start, end, allDay: range.allDay }
}

export const STATUS_TEXT: Record<EventStatusValue, string> = {
  confirmed: 'CONFIRMED',
  tentative: 'TENTATIVE',
  cancelled: 'CANCELLED',
}

export function checkChanges(changes: EventChanges): void {
  if (changes.title !== undefined && !changes.title.trim()) {
    throw new EditError('invalid-input', t('The title is empty.'))
  }
  if (changes.status !== undefined && !(changes.status in STATUS_TEXT)) {
    throw new EditError(
      'invalid-input',
      t('Unknown status: {status}', { status: String(changes.status) }),
    )
  }
}

const RECURRENCE_ID_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/

export function checkRecurrenceId(id: string): string {
  if (!RECURRENCE_ID_RE.test(id)) {
    throw new EditError(
      'invalid-input',
      t('The recurrence id is not a date or a UTC instant: {id}', { id }),
    )
  }
  return id
}

export function nowOf(ctx: WriteContext): Date {
  return ctx.now ?? new Date()
}

// ---------------------------------------------------------------------------------------------
// The document

export interface Doc {
  root: Comp
  calendar: Comp
  master: Comp | undefined
  overrides: Comp[]
  resolver: ZoneResolver
}

export function openDocument(ics: string, ctx: WriteContext): Doc {
  const root = parseDocument(ics)
  const calendar = subcomponents(root, 'VCALENDAR')[0]
  if (!calendar) throw new EditError('unparseable', 'The text has no VCALENDAR.')
  const events = subcomponents(calendar, 'VEVENT')
  if (events.length === 0) throw new EditError('unparseable', 'The calendar has no VEVENT.')
  const master = events.find((e) => !firstProp(e, 'RECURRENCE-ID'))
  return {
    root,
    calendar,
    master,
    overrides: events.filter((e) => e !== master && firstProp(e, 'RECURRENCE-ID')),
    resolver: new ZoneResolver(calendar, ctx.orgTimeZone),
  }
}

/** UTC and its aliases are written as `Z` times, not as a TZID with a VTIMEZONE. */
function isUtcName(zone: string): boolean {
  return zone === 'UTC' || zone === 'Etc/UTC' || zone === 'Etc/GMT'
}

/** The kind of time a timed event gets when it has none of its own: the editor's zone. */
export function displayInfo(ctx: WriteContext): TimeInfo {
  return isUtcName(ctx.displayTimeZone)
    ? { kind: 'utc' }
    : { kind: 'zoned', tzid: ctx.displayTimeZone }
}

// ---------------------------------------------------------------------------------------------
// Metadata

export function stampOf(now: Date): string {
  return toBasicUtc(now.getTime())
}

/** Marks a component as changed: SEQUENCE up by one, DTSTAMP and LAST-MODIFIED now. */
export function touch(comp: Comp, now: Date, resetSequence = false): void {
  const current = firstProp(comp, 'SEQUENCE')
  const sequence = current ? Number.parseInt(rawValue(current), 10) : 0
  const next = resetSequence ? 0 : (Number.isFinite(sequence) ? sequence : 0) + 1
  replaceProps(comp, 'SEQUENCE', [makeProp('SEQUENCE', [], String(next))])
  replaceProps(comp, 'DTSTAMP', [makeProp('DTSTAMP', [], stampOf(now))])
  replaceProps(comp, 'LAST-MODIFIED', [makeProp('LAST-MODIFIED', [], stampOf(now))])
}

// ---------------------------------------------------------------------------------------------
// Scalar changes (everything but the time)

function setText(comp: Comp, name: string, value: string | null, alsoDrop: string[] = []): boolean {
  const existing = props(comp, name)
  if (value === null || value === '') {
    if (existing.length === 0) return false
    removeProps(comp, name)
    for (const other of alsoDrop) removeProps(comp, other)
    return true
  }
  const text = value.replace(/\r\n?/g, '\n')
  if (existing.length === 1 && unescapeText(rawValue(existing[0]!)) === text) return false
  const base = existing[0]
  // ALTREP points at the old text; X-ALT-DESC is the HTML copy of the old description.
  const next = base
    ? withValue(withParams(base, ['ALTREP'], []), escapeText(text))
    : makeProp(name, [], escapeText(text))
  replaceProps(comp, name, [next])
  for (const other of alsoDrop) removeProps(comp, other)
  return true
}

function setStatus(comp: Comp, status: EventStatusValue): boolean {
  const existing = props(comp, 'STATUS')
  const current = existing[0] ? rawValue(existing[0]).trim().toUpperCase() : 'CONFIRMED'
  if (existing.length <= 1 && current === STATUS_TEXT[status]) return false
  replaceProps(comp, 'STATUS', [makeProp('STATUS', [], STATUS_TEXT[status])])
  return true
}

function setCategories(comp: Comp, names: string[]): boolean {
  const wanted = names.map((n) => n.trim()).filter(Boolean)
  const current = props(comp, 'CATEGORIES').flatMap((p) => splitTextList(rawValue(p)))
  if (wanted.length === current.length && wanted.every((name, i) => name === current[i]))
    return false
  if (wanted.length === 0) {
    removeProps(comp, 'CATEGORIES')
    return true
  }
  replaceProps(comp, 'CATEGORIES', [makeProp('CATEGORIES', [], wanted.map(escapeText).join(','))])
  return true
}

/** Applies title, description, location, status and categories; true when a line changed. */
export function applyScalars(comp: Comp, changes: EventChanges): boolean {
  let changed = false
  if (changes.title !== undefined) changed = setText(comp, 'SUMMARY', changes.title) || changed
  if (changes.description !== undefined) {
    changed = setText(comp, 'DESCRIPTION', changes.description, ['X-ALT-DESC']) || changed
  }
  if (changes.location !== undefined)
    changed = setText(comp, 'LOCATION', changes.location) || changed
  if (changes.status !== undefined) changed = setStatus(comp, changes.status) || changed
  if (changes.categoryNames !== undefined) {
    changed = setCategories(comp, changes.categoryNames) || changed
  }
  return changed
}

// ---------------------------------------------------------------------------------------------
// Ranges

export interface Range {
  info: TimeInfo
  start: string
  end: string
}

/** Seconds of an ISO 8601 duration (`PT1H`, `P1D`, `P1W`); null when it is not one. */
function durationSeconds(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    value.trim(),
  )
  if (!match) return null
  const [, sign, w, d, h, m, s] = match
  const total =
    Number(w ?? 0) * 604_800 +
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3600 +
    Number(m ?? 0) * 60 +
    Number(s ?? 0)
  return sign === '-' ? -total : total
}

/** Start and end of a component in its own zone; the end falls back to DURATION, then to the default. */
export function currentRange(comp: Comp, resolver: ZoneResolver): Range {
  const dtstart = firstProp(comp, 'DTSTART')
  const start = dtstart ? readTime(dtstart) : null
  if (!start) throw new EditError('unparseable', 'The event has no readable DTSTART.')
  const { info } = start
  const dtend = firstProp(comp, 'DTEND')
  const end = dtend ? readTime(dtend) : null
  if (end) {
    let wall = end.wall
    if (!sameInfo(end.info, info)) {
      if (info.kind === 'date') wall = end.wall.slice(0, 10)
      else if (end.info.kind === 'date') wall = `${end.wall}${start.wall.slice(10)}`
      else wall = resolver.zoneFor(info).toWall(resolver.zoneFor(end.info).toInstant(end.wall))
    }
    return { info, start: start.wall, end: wall }
  }
  const duration = firstProp(comp, 'DURATION')
  const seconds = duration ? durationSeconds(rawValue(duration)) : null
  if (seconds !== null) {
    return {
      info,
      start: start.wall,
      end:
        info.kind === 'date'
          ? dateAddDays(start.wall, Math.round(seconds / 86_400))
          : wallAddSeconds(start.wall, seconds),
    }
  }
  return {
    info,
    start: start.wall,
    end: info.kind === 'date' ? dateAddDays(start.wall, 1) : start.wall,
  }
}

export function lengthOf(range: Pick<Range, 'info' | 'start' | 'end'>): number {
  return range.info.kind === 'date'
    ? daysBetween(range.start, range.end)
    : wallDiffSeconds(range.start, range.end)
}

export function addLength(info: TimeInfo, start: string, length: number): string {
  return info.kind === 'date' ? dateAddDays(start, length) : wallAddSeconds(start, length)
}

/**
 * The editor's range in the zone the event is written in: all-day stays dates, a timed range keeps
 * the event's own zone (TZID, UTC, or floating read in the organization zone) and an event that was
 * all-day gets the display zone.
 */
export function resolveWhen(
  range: WallClockRange,
  current: TimeInfo,
  ctx: WriteContext,
  resolver: ZoneResolver,
): Range {
  const parsed = parseRange(range)
  if (parsed.allDay) return { info: { kind: 'date' }, start: parsed.start, end: parsed.end }
  const info = current.kind === 'date' ? displayInfo(ctx) : current
  const same =
    (info.kind === 'zoned' && ianaNameOf(info.tzid) === ctx.displayTimeZone) ||
    (info.kind === 'utc' && isUtcName(ctx.displayTimeZone))
  if (same) return { info, start: parsed.start, end: parsed.end }
  const display = zoneNamed(ctx.displayTimeZone)
  const target = resolver.zoneFor(info)
  return {
    info,
    start: target.toWall(display.toInstant(parsed.start)),
    end: target.toWall(display.toInstant(parsed.end)),
  }
}

/** Writes DTSTART and, when given, DTEND (removing DURATION); keeps parameters when the kind is unchanged. */
export function writeRange(comp: Comp, info: TimeInfo, start: string, end: string | null): void {
  const dtstart = firstProp(comp, 'DTSTART')
  const oldStart = dtstart ? readTime(dtstart) : null
  replaceProps(comp, 'DTSTART', [
    dtstart
      ? withTime(dtstart, oldStart?.info ?? info, info, start)
      : makeTimeProp('DTSTART', info, start),
  ])
  if (end === null) return
  const dtend = firstProp(comp, 'DTEND')
  const oldEnd = dtend ? readTime(dtend) : null
  if (dtend) replaceProps(comp, 'DTEND', [withTime(dtend, oldEnd?.info ?? info, info, end)])
  else insertPropAfter(comp, makeTimeProp('DTEND', info, end), firstProp(comp, 'DTSTART'))
  removeProps(comp, 'DURATION')
}

// ---------------------------------------------------------------------------------------------
// VTIMEZONE

/** Adds a generated VTIMEZONE for a TZID the file does not describe (a no-op for other kinds). */
export function ensureTimezone(calendar: Comp, info: TimeInfo, anchorWall: string): void {
  if (info.kind !== 'zoned') return
  const known = subcomponents(calendar, 'VTIMEZONE').some((c) => {
    const tzid = firstProp(c, 'TZID')
    return tzid && rawValue(tzid) === info.tzid
  })
  // A generated block carries the IANA name; a path-style TZID would need a block of the same name.
  if (known || !isValidTimeZone(info.tzid)) return
  const block = parseDocument(
    generateVTimezone(info.tzid, Number(anchorWall.slice(0, 4))).join('\r\n'),
  ).children[0]
  if (!block || block.kind !== 'comp') return
  const zones = calendar.children.filter((c) => c.kind === 'comp' && c.name === 'VTIMEZONE')
  const anchor = zones[zones.length - 1] ?? calendar.children.find((c) => c.kind === 'comp')
  const at = anchor
    ? calendar.children.indexOf(anchor) + (zones.length > 0 ? 1 : 0)
    : calendar.children.length
  calendar.children.splice(at, 0, block)
}
