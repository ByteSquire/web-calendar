// Creating and editing events as iCalendar text (design §7 "Writes", §12 "Recurring edits").
// Pure functions on strings: the caller fetches the resource, passes it in with the user's changes
// and PUTs what comes back with `If-Match`. An edit changes only what the user changed: every other
// line of the resource (attendees with their parameters, alarms, X- properties, unusual rules,
// VTIMEZONEs, overrides) is kept as it was read, see write-lines.ts.
import {
  cloneComp,
  escapeText,
  firstProp,
  insertProp,
  insertPropAfter,
  makeProp,
  parseDocument,
  props,
  rawValue,
  removeProps,
  replaceProps,
  serializeDocument,
  splitTextList,
  subcomponents,
  unescapeText,
  withParams,
  withValue,
  rewriteProps,
  type Comp,
  type Prop,
} from './write-lines'
import { t } from '../i18n'
import { X_BOOKING, X_BOOKING_STATUS, X_RESOURCE } from './x-properties'
import {
  editRule,
  excludedIds,
  hasOccurrence,
  identityMap,
  isConsistent,
  isRecurring,
  lookupSlot,
  makeSlotMap,
  mapUntilToken,
  masterWallOf,
  overrideId,
  ruleCount,
  ruleSlotsBefore,
  seriesContext,
  startWallOf,
  transformTimeList,
  truncateSeries,
  wallInInfo,
  type SeriesContext,
  type Slot,
  type SlotMap,
} from './recurrence-edit'
import { generateVTimezone } from './vtimezone'
import {
  EditError,
  type EditResult,
  type EditScope,
  type EventChanges,
  type EventStatusValue,
  type NewEventInput,
  type NewEventRecurrence,
  type NewEventResource,
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
  toBasic,
  toBasicUtc,
  wallAddSeconds,
  wallDiffSeconds,
  withTime,
  zoneNamed,
  ZoneResolver,
  type TimeInfo,
} from './write-zone'
import { isValidTimeZone } from '../../../shared/utils/time-zone'

export { EditError } from './write-types'
export type {
  EditErrorCode,
  EditResult,
  EditScope,
  EventChanges,
  NewEventInput,
  NewEventRecurrence,
  NewEventResource,
  WallClockRange,
  WriteContext,
} from './write-types'

const PRODID = '-//web-calendar//Web Calendar//EN'

// ---------------------------------------------------------------------------------------------
// Input checks

function checkContext(ctx: WriteContext): void {
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
function parseRange(range: WallClockRange): WallClockRange {
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

const STATUS_TEXT: Record<EventStatusValue, string> = {
  confirmed: 'CONFIRMED',
  tentative: 'TENTATIVE',
  cancelled: 'CANCELLED',
}

function checkChanges(changes: EventChanges): void {
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

function checkRecurrenceId(id: string): string {
  if (!RECURRENCE_ID_RE.test(id)) {
    throw new EditError(
      'invalid-input',
      t('The recurrence id is not a date or a UTC instant: {id}', { id }),
    )
  }
  return id
}

function nowOf(ctx: WriteContext): Date {
  return ctx.now ?? new Date()
}

// ---------------------------------------------------------------------------------------------
// The document

interface Doc {
  root: Comp
  calendar: Comp
  master: Comp | undefined
  overrides: Comp[]
  resolver: ZoneResolver
}

function openDocument(ics: string, ctx: WriteContext): Doc {
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
function displayInfo(ctx: WriteContext): TimeInfo {
  return isUtcName(ctx.displayTimeZone)
    ? { kind: 'utc' }
    : { kind: 'zoned', tzid: ctx.displayTimeZone }
}

// ---------------------------------------------------------------------------------------------
// Metadata

function stampOf(now: Date): string {
  return toBasicUtc(now.getTime())
}

/** Marks a component as changed: SEQUENCE up by one, DTSTAMP and LAST-MODIFIED now. */
function touch(comp: Comp, now: Date, resetSequence = false): void {
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
function applyScalars(comp: Comp, changes: EventChanges): boolean {
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

interface Range {
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
function currentRange(comp: Comp, resolver: ZoneResolver): Range {
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

function lengthOf(range: Pick<Range, 'info' | 'start' | 'end'>): number {
  return range.info.kind === 'date'
    ? daysBetween(range.start, range.end)
    : wallDiffSeconds(range.start, range.end)
}

function addLength(info: TimeInfo, start: string, length: number): string {
  return info.kind === 'date' ? dateAddDays(start, length) : wallAddSeconds(start, length)
}

/**
 * The editor's range in the zone the event is written in: all-day stays dates, a timed range keeps
 * the event's own zone (TZID, UTC, or floating read in the organization zone) and an event that was
 * all-day gets the display zone.
 */
function resolveWhen(
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
function writeRange(comp: Comp, info: TimeInfo, start: string, end: string | null): void {
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
function ensureTimezone(calendar: Comp, info: TimeInfo, anchorWall: string): void {
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

// ---------------------------------------------------------------------------------------------
// Series scope

/** Shifts one override with its slot: RECURRENCE-ID always, DTSTART/DTEND when it follows the slot. */
function moveOverride(
  override: Comp,
  ctx: SeriesContext,
  startWall: string,
  map: SlotMap,
  oldLength: number,
  newLength: number,
  durationChanged: boolean,
): boolean {
  const ridProp = firstProp(override, 'RECURRENCE-ID')
  const rid = ridProp ? readTime(ridProp) : null
  if (!ridProp || !rid) return false
  const oldSlot = masterWallOf(rid, ctx, startWall)
  const newSlot = map.apply(oldSlot)
  const range = currentRange(override, ctx.resolver)
  const ownStart = masterWallOf({ info: range.info, wall: range.start }, ctx, startWall)
  const ownLength = lengthOf(range)
  if (!map.identity) {
    const info = map.kindChanged ? map.newInfo : rid.info
    const wall = map.kindChanged ? newSlot : wallInInfo(newSlot, rid.info, ctx)
    replaceProps(override, 'RECURRENCE-ID', [withTime(ridProp, rid.info, info, wall)])
  }
  let modified = !map.identity
  if (map.identity && !durationChanged) return false
  // An override whose start was never moved from its slot moves with it; a custom time stays
  // (unless the kind of time changes, which resets it to the slot). One whose own time is a date
  // while the series is timed (or the reverse) is left as written.
  const sameDateness = (range.info.kind === 'date') === (ctx.info.kind === 'date')
  if (!sameDateness && !map.kindChanged) return modified
  if (ownStart === oldSlot || map.kindChanged) {
    const info = map.kindChanged ? map.newInfo : range.info
    const start = map.kindChanged ? newSlot : wallInInfo(newSlot, range.info, ctx)
    const length = ownLength === oldLength || map.kindChanged ? newLength : ownLength
    writeRange(override, info, start, addLength(info, start, length))
    modified = true
  }
  return modified
}

/**
 * Edits the whole series (or a single event). With `anchorId`, `changes.when` describes that
 * occurrence and the series moves by the same wall-clock delta; without it `when` is the new range
 * of the first occurrence.
 */
function editSeries(
  doc: Doc,
  anchorId: string | undefined,
  changes: EventChanges,
  ctx: WriteContext,
  now: Date,
): boolean {
  const master = doc.master
  if (!master)
    throw new EditError('unsupported', 'The resource has no series, only single occurrences.')
  const recurring = isRecurring(master)
  const series = seriesContext(master, doc.resolver)
  const startWall = startWallOf(master)
  const masterRange = currentRange(master, doc.resolver)
  let changed = applyScalars(master, changes)

  let map: SlotMap = identityMap(series.info)
  let newRange: { info: TimeInfo; start: string; end: string } | null = null
  const oldLength = lengthOf(masterRange)
  if (changes.when) {
    const resolved = resolveWhen(changes.when, series.info, ctx, doc.resolver)
    // The occurrence the editor was looking at, in the series' wall clock.
    let anchor: { start: string; end: string } = masterRange
    if (anchorId !== undefined && recurring) {
      const id = checkRecurrenceId(anchorId)
      const found = lookupSlot(master, series, id, excludedIds(master, series))
      if (!found || found.excluded)
        throw new EditError('unknown-instance', `No occurrence at ${id}.`)
      const override = doc.overrides.find((o) => overrideId(o, series) === id)
      if (override) {
        const own = currentRange(override, doc.resolver)
        anchor = {
          start: masterWallOf({ info: own.info, wall: own.start }, series, startWall),
          end: masterWallOf({ info: own.info, wall: own.end }, series, startWall),
        }
      } else {
        anchor = { start: found.slot.wall, end: addLength(series.info, found.slot.wall, oldLength) }
      }
    }
    const unchanged =
      sameInfo(resolved.info, series.info) &&
      resolved.start === anchor.start &&
      resolved.end === anchor.end
    if (!unchanged) {
      map = makeSlotMap(series.info, resolved.info, anchor.start, resolved.start)
      const start = map.apply(startWall)
      newRange = {
        info: resolved.info,
        start,
        end: addLength(resolved.info, start, lengthOf(resolved)),
      }
    }
  }

  const guarded =
    recurring &&
    !map.identity &&
    map.dayShift !== 0 &&
    isConsistent(master, doc.overrides, doc.resolver)
  if (newRange) {
    writeRange(master, newRange.info, newRange.start, newRange.end)
    ensureTimezone(doc.calendar, newRange.info, newRange.start)
    changed = true
  }
  if (newRange && recurring) {
    const newLength = lengthOf(newRange)
    const newZone = doc.resolver.zoneFor(newRange.info)
    if (!map.identity) {
      rewriteProps(master, 'RRULE', (prop) =>
        editRule(prop, {
          mapUntil: (token) => mapUntilToken(token, series, map, newZone),
          byDayShift: map.dayShift,
        }),
      )
      const edit = { map, newZone }
      rewriteProps(master, 'EXDATE', (prop) => transformTimeList(prop, series, startWall, edit))
      rewriteProps(master, 'RDATE', (prop) => transformTimeList(prop, series, startWall, edit))
    }
    const durationChanged = newLength !== oldLength || map.kindChanged
    for (const override of doc.overrides) {
      if (moveOverride(override, series, startWall, map, oldLength, newLength, durationChanged)) {
        touch(override, now)
      }
    }
  }
  if (guarded && !isConsistent(master, doc.overrides, doc.resolver)) throw moveRefused()
  if (changed) touch(master, now)
  return changed
}

/** A move by whole days that the recurrence rule does not follow (see `isConsistent`). */
function moveRefused(): EditError {
  return new EditError(
    'unsupported',
    t(
      'The recurrence rule does not follow a move to another day; edit single occurrences instead.',
    ),
  )
}

// ---------------------------------------------------------------------------------------------
// Instance scope

function findOverride(doc: Doc, id: string, series: SeriesContext): Comp | undefined {
  return doc.overrides.find((o) => overrideId(o, series) === id)
}

/** A new series made by a split is not what the booking was made for: it must not claim it. */
function dropBookingProps(comp: Comp): void {
  for (const name of [X_RESOURCE, X_BOOKING, X_BOOKING_STATUS]) removeProps(comp, name)
}

/** A new override for `slot`: a copy of the master without its recurrence properties. */
function buildOverride(master: Comp, slot: Slot, series: SeriesContext, doc: Doc): Comp {
  const copy = cloneComp(master)
  for (const name of ['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID'])
    removeProps(copy, name)
  const range = currentRange(master, doc.resolver)
  const length = lengthOf(range)
  const dtend = firstProp(copy, 'DTEND')
  writeRange(copy, series.info, slot.wall, null)
  if (dtend) {
    const endInfo = readTime(dtend)?.info ?? series.info
    const end = addLength(series.info, slot.wall, length)
    replaceProps(copy, 'DTEND', [
      withTime(dtend, endInfo, endInfo, wallInInfo(end, endInfo, series)),
    ])
  }
  insertProp(
    copy,
    makeTimeProp('RECURRENCE-ID', series.info, slot.wall),
    firstProp(copy, 'DTSTART'),
  )
  return copy
}

function insertAfterLastEvent(calendar: Comp, comp: Comp): void {
  let last = -1
  calendar.children.forEach((c, i) => {
    if (c.kind === 'comp' && c.name === 'VEVENT') last = i
  })
  calendar.children.splice(last + 1, 0, comp)
}

function editInstance(
  doc: Doc,
  recurrenceId: string,
  changes: EventChanges,
  ctx: WriteContext,
  now: Date,
): boolean {
  const id = checkRecurrenceId(recurrenceId)
  const first = doc.master ?? doc.overrides[0]
  if (!first) throw new EditError('unparseable', 'The calendar has no VEVENT.')
  const series = seriesContext(first, doc.resolver)
  let override = findOverride(doc, id, series)
  let created = false
  if (!override) {
    if (!doc.master) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    const found = lookupSlot(doc.master, series, id, excludedIds(doc.master, series))
    if (!found || found.excluded) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    override = buildOverride(doc.master, found.slot, series, doc)
    created = true
  }
  let changed = applyScalars(override, changes)
  if (changes.when) {
    const current = currentRange(override, doc.resolver)
    const resolved = resolveWhen(changes.when, current.info, ctx, doc.resolver)
    if (
      !sameInfo(resolved.info, current.info) ||
      resolved.start !== current.start ||
      resolved.end !== current.end
    ) {
      writeRange(override, resolved.info, resolved.start, resolved.end)
      ensureTimezone(doc.calendar, resolved.info, resolved.start)
      changed = true
    }
  }
  if (!changed) return false
  touch(override, now)
  if (created) insertAfterLastEvent(doc.calendar, override)
  return true
}

// ---------------------------------------------------------------------------------------------
// This and following

function editThisAndFollowing(
  doc: Doc,
  recurrenceId: string,
  changes: EventChanges,
  ctx: WriteContext,
  now: Date,
): { changed: boolean; created: NewEventResource | null } {
  const master = doc.master!
  const id = checkRecurrenceId(recurrenceId)
  const series = seriesContext(master, doc.resolver)
  const startWall = startWallOf(master)
  const found = lookupSlot(master, series, id, excludedIds(master, series))
  if (!found || found.excluded) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
  // Nothing before the slot: the whole series is meant.
  if (!found.hasEarlierOccurrence) {
    return { changed: editSeries(doc, id, changes, ctx, now), created: null }
  }

  const slot = found.slot
  const masterRange = currentRange(master, doc.resolver)
  const oldLength = lengthOf(masterRange)
  const target = findOverride(doc, id, series)
  let anchor = { start: slot.wall, end: addLength(series.info, slot.wall, oldLength) }
  if (target) {
    const own = currentRange(target, doc.resolver)
    anchor = {
      start: masterWallOf({ info: own.info, wall: own.start }, series, startWall),
      end: masterWallOf({ info: own.info, wall: own.end }, series, startWall),
    }
  }
  let map: SlotMap = identityMap(series.info)
  let resolved: Range | null = null
  if (changes.when) {
    const candidate = resolveWhen(changes.when, series.info, ctx, doc.resolver)
    const unchanged =
      sameInfo(candidate.info, series.info) &&
      candidate.start === anchor.start &&
      candidate.end === anchor.end
    if (!unchanged) {
      resolved = candidate
      map = makeSlotMap(series.info, candidate.info, anchor.start, candidate.start)
    }
  }
  // Nothing to change, nothing to split.
  if (!resolved && !applyScalars(cloneComp(master), changes)) {
    return { changed: false, created: null }
  }
  const guarded =
    !map.identity && map.dayShift !== 0 && isConsistent(master, doc.overrides, doc.resolver)
  const newInfo = map.newInfo
  const newLength = resolved ? lengthOf(resolved) : oldLength
  const newStart = map.apply(slot.wall)
  const newZone = doc.resolver.zoneFor(newInfo)

  // The new series, from a copy of the master as it was.
  const uid = globalThis.crypto.randomUUID()
  const successor = cloneComp(master)
  replaceProps(successor, 'UID', [makeProp('UID', [], uid)])
  dropBookingProps(successor)
  writeRange(
    successor,
    newInfo,
    newStart,
    resolved || firstProp(master, 'DTEND') ? addLength(newInfo, newStart, newLength) : null,
  )
  const sourceRules = props(master, 'RRULE')
  const targetRules = props(successor, 'RRULE')
  targetRules.forEach((rule, index) => {
    const source = sourceRules[index]!
    const count = ruleCount(source)
    const edit: Parameters<typeof editRule>[1] = {}
    if (!map.identity) {
      edit.mapUntil = (token) => mapUntilToken(token, series, map, newZone)
      edit.byDayShift = map.dayShift
    }
    if (count !== null) {
      const remaining = count - ruleSlotsBefore(master, series, source, slot.wall)
      if (remaining <= 0) {
        removeRule(successor, rule)
        return
      }
      edit.count = remaining
    }
    rewriteProps(successor, 'RRULE', (prop) => (prop === rule ? editRule(prop, edit) : prop))
  })
  const fromSlot = (_wall: string, slotId: string): boolean => slotId >= slot.id
  const listEdit = { keep: fromSlot, map, newZone }
  rewriteProps(successor, 'EXDATE', (prop) => transformTimeList(prop, series, startWall, listEdit))
  rewriteProps(successor, 'RDATE', (prop) => transformTimeList(prop, series, startWall, listEdit))
  applyScalars(successor, changes)
  replaceProps(successor, 'CREATED', [makeProp('CREATED', [], stampOf(now))])
  touch(successor, now, true)

  // The overrides from the slot on move with it; the one at the slot gets the edit as well.
  const moved: Comp[] = []
  for (const override of doc.overrides) {
    const overrideSlot = overrideId(override, series)
    if (overrideSlot === null || overrideSlot < slot.id) continue
    const copy = cloneComp(override)
    replaceProps(copy, 'UID', [makeProp('UID', [], uid)])
    dropBookingProps(copy)
    moveOverride(
      copy,
      series,
      startWall,
      map,
      oldLength,
      newLength,
      newLength !== oldLength || map.kindChanged,
    )
    if (overrideSlot === slot.id) {
      applyScalars(copy, changes)
      if (resolved && changes.when) {
        const own = resolveWhen(
          changes.when,
          currentRange(copy, doc.resolver).info,
          ctx,
          doc.resolver,
        )
        writeRange(copy, own.info, own.start, own.end)
      }
    }
    touch(copy, now, true)
    moved.push(copy)
  }

  if (guarded && !isConsistent(successor, moved, doc.resolver)) throw moveRefused()

  // The original series ends before the slot and loses what moved.
  truncateSeries(master, slot, series)
  const leaving = doc.overrides.filter((o) => isMoved(o, series, slot))
  doc.calendar.children = doc.calendar.children.filter(
    (c) => !(c.kind === 'comp' && leaving.includes(c)),
  )
  touch(master, now)

  // The new resource: the calendar's own properties and VTIMEZONEs, the new master, its overrides.
  const calendar = cloneComp(doc.calendar)
  calendar.children = [
    ...calendar.children.filter(
      (c) => c.kind === 'prop' || (c.kind === 'comp' && c.name === 'VTIMEZONE'),
    ),
    successor,
    ...moved,
  ]
  ensureTimezone(calendar, newInfo, newStart)
  const root: Comp = { kind: 'comp', name: '', beginRaw: '', endRaw: '', children: [calendar] }
  return { changed: true, created: { uid, ics: serializeDocument(root) } }
}

function isMoved(override: Comp, series: SeriesContext, slot: Slot): boolean {
  const id = overrideId(override, series)
  return id !== null && id >= slot.id
}

function removeRule(comp: Comp, rule: Prop): void {
  comp.children = comp.children.filter((c) => c !== rule)
}

// ---------------------------------------------------------------------------------------------
// Public: edit

/**
 * Applies `changes` to the resource `ics` and returns its new text. `scope` says which part of a
 * recurring event the change is about (a single event is always its own series). `created` is set
 * when "this and following" split the series: that text is a new resource with a new UID.
 *
 * Throws `EditError` (`invalid-input`, `unknown-instance`, `unparseable`, `unsupported`).
 */
export function editEventResource(
  ics: string,
  scope: EditScope,
  changes: EventChanges,
  ctx: WriteContext,
): EditResult {
  checkContext(ctx)
  checkChanges(changes)
  if (changes.when) parseRange(changes.when)
  const doc = openDocument(ics, ctx)
  const now = nowOf(ctx)
  const recurring = !!doc.master && isRecurring(doc.master)

  let changed: boolean
  let created: NewEventResource | null = null
  if (!doc.master) {
    if (scope.kind === 'series') {
      throw new EditError(
        'unsupported',
        'The resource has single occurrences but no series to edit.',
      )
    }
    changed = editInstance(doc, scope.recurrenceId, changes, ctx, now)
  } else if (!recurring || scope.kind === 'series') {
    changed = editSeries(
      doc,
      scope.kind === 'series' ? scope.recurrenceId : undefined,
      changes,
      ctx,
      now,
    )
  } else if (scope.kind === 'instance') {
    changed = editInstance(doc, scope.recurrenceId, changes, ctx, now)
  } else {
    const result = editThisAndFollowing(doc, scope.recurrenceId, changes, ctx, now)
    changed = result.changed
    created = result.created
  }
  if (!changed) return { updated: ics, created: null }
  return { updated: serializeDocument(doc.root), created }
}

// ---------------------------------------------------------------------------------------------
// Public: delete

/**
 * Removes part of an event. `updated` is the new text of the resource, or null when nothing is left
 * of it (delete the resource): a single event, a whole series, a series cut at its first occurrence
 * or emptied.
 */
export function deleteFromEventResource(
  ics: string,
  scope: EditScope,
  ctx: WriteContext,
): { updated: string | null } {
  checkContext(ctx)
  const doc = openDocument(ics, ctx)
  const now = nowOf(ctx)
  const master = doc.master
  if (scope.kind === 'series') return { updated: null }

  if (!master) {
    const id = checkRecurrenceId(scope.recurrenceId)
    const series = seriesContext(doc.overrides[0]!, doc.resolver)
    const override = findOverride(doc, id, series)
    if (!override) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    doc.calendar.children = doc.calendar.children.filter((c) => c !== override)
    return {
      updated:
        subcomponents(doc.calendar, 'VEVENT').length === 0 ? null : serializeDocument(doc.root),
    }
  }
  if (!isRecurring(master)) return { updated: null }

  const id = checkRecurrenceId(scope.recurrenceId)
  const series = seriesContext(master, doc.resolver)
  const excluded = excludedIds(master, series)
  const found = lookupSlot(master, series, id, excluded)
  const override = findOverride(doc, id, series)

  if (scope.kind === 'instance') {
    if ((!found || found.excluded) && !override) {
      throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    }
    if (override) doc.calendar.children = doc.calendar.children.filter((c) => c !== override)
    if (found && !found.excluded) {
      const exdate = makeTimeProp('EXDATE', series.info, found.slot.wall)
      const anchor = [
        ...props(master, 'EXDATE'),
        ...props(master, 'RRULE'),
        ...props(master, 'RDATE'),
      ].pop()
      insertPropAfter(master, exdate, anchor ?? firstProp(master, 'DTSTART'))
      excluded.add(id)
      touch(master, now)
    }
    if (!hasOccurrence(master, series, excluded)) return { updated: null }
    return { updated: serializeDocument(doc.root) }
  }

  if (!found || found.excluded) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
  if (!found.hasEarlierOccurrence) return { updated: null }
  truncateSeries(master, found.slot, series)
  doc.calendar.children = doc.calendar.children.filter(
    (c) => !(c.kind === 'comp' && doc.overrides.includes(c) && isMoved(c, series, found.slot)),
  )
  touch(master, now)
  return { updated: serializeDocument(doc.root) }
}

// ---------------------------------------------------------------------------------------------
// Public: create

const WEEKDAY_RE = /^[+-]?\d{0,2}(MO|TU|WE|TH|FR|SA|SU)$/

function integerList(
  values: number[] | undefined,
  what: 'monthDay' | 'setPos',
  min: number,
  max: number,
): number[] {
  const list = values ?? []
  for (const n of list) {
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) < min || Math.abs(n) > max) {
      throw new EditError(
        'invalid-input',
        what === 'monthDay'
          ? t(
              'Days of the month must be whole numbers from {min} to {max} (or negative): {value}',
              {
                min,
                max,
                value: n,
              },
            )
          : t('Set positions must be whole numbers from {min} to {max} (or negative): {value}', {
              min,
              max,
              value: n,
            }),
      )
    }
  }
  return list
}

function buildRule(
  rule: NewEventRecurrence,
  range: WallClockRange,
  info: TimeInfo,
  ctx: WriteContext,
): string {
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) {
    throw new EditError(
      'invalid-input',
      t('Unknown frequency: {freq}', { freq: String(rule.freq) }),
    )
  }
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval !== undefined) {
    if (!Number.isInteger(rule.interval) || rule.interval < 1) {
      throw new EditError(
        'invalid-input',
        t('The interval must be a whole number of 1 or more: {value}', { value: rule.interval }),
      )
    }
    if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  }
  const byMonth = rule.byMonth ?? []
  for (const m of byMonth) {
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new EditError('invalid-input', t('A month must be 1 to 12: {value}', { value: m }))
    }
  }
  const byMonthDay = integerList(rule.byMonthDay, 'monthDay', 1, 31)
  const bySetPos = integerList(rule.bySetPos, 'setPos', 1, 366)
  const byDay = rule.byDay ?? []
  for (const day of byDay) {
    if (!WEEKDAY_RE.test(day))
      throw new EditError('invalid-input', t('Not a weekday: {day}', { day }))
    if (/\d/.test(day) && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
      throw new EditError(
        'invalid-input',
        t('A numbered weekday ({day}) needs a monthly or yearly rule.', { day }),
      )
    }
  }
  if (bySetPos.length > 0 && byDay.length + byMonthDay.length + byMonth.length === 0) {
    throw new EditError(
      'invalid-input',
      t('BYSETPOS needs another BY part (a weekday, day of month or month).'),
    )
  }
  if (byMonth.length) parts.push(`BYMONTH=${byMonth.join(',')}`)
  if (byMonthDay.length) parts.push(`BYMONTHDAY=${byMonthDay.join(',')}`)
  if (byDay.length) parts.push(`BYDAY=${byDay.join(',')}`)
  if (bySetPos.length) parts.push(`BYSETPOS=${bySetPos.join(',')}`)
  if (rule.count !== undefined && rule.until !== undefined) {
    throw new EditError('invalid-input', t('A rule has a count or an end date, not both.'))
  }
  if (rule.count !== undefined) {
    if (!Number.isInteger(rule.count) || rule.count < 1) {
      throw new EditError(
        'invalid-input',
        t('The count must be a whole number of 1 or more: {value}', { value: rule.count }),
      )
    }
    parts.push(`COUNT=${rule.count}`)
  }
  if (rule.until !== undefined) {
    const until = normalizeWall(rule.until, 'until')
    if (info.kind === 'date') {
      if (until < range.start)
        throw new EditError('invalid-input', t('The series ends before it starts.'))
      parts.push(`UNTIL=${toBasic(until.slice(0, 10))}`)
    } else {
      const wall = isDateWall(until) ? `${until}T23:59:59` : until
      if (wall < range.start)
        throw new EditError('invalid-input', t('The series ends before it starts.'))
      parts.push(`UNTIL=${toBasicUtc(zoneNamed(ctx.displayTimeZone).toInstant(wall))}`)
    }
  }
  return parts.join(';')
}

/**
 * A new event as a complete `.ics` resource with a fresh UID. Timed events carry `TZID=<display
 * zone>` and a generated VTIMEZONE (`Z` times when the display zone is UTC), all-day events use
 * dates; nothing is floating.
 */
export function createEventResource(input: NewEventInput, ctx: WriteContext): NewEventResource {
  checkContext(ctx)
  if (!input.title.trim()) throw new EditError('invalid-input', t('The title is empty.'))
  checkChanges({ status: input.status })
  const range = parseRange(input.when)
  const info: TimeInfo = range.allDay ? { kind: 'date' } : displayInfo(ctx)
  const uid = globalThis.crypto.randomUUID()
  const now = stampOf(nowOf(ctx))

  const event: Comp = { kind: 'comp', name: 'VEVENT', beginRaw: '', endRaw: '', children: [] }
  const add = (prop: Prop): void => {
    event.children.push(prop)
  }
  add(makeProp('UID', [], uid))
  add(makeProp('DTSTAMP', [], now))
  add(makeProp('CREATED', [], now))
  add(makeProp('LAST-MODIFIED', [], now))
  add(makeProp('SEQUENCE', [], '0'))
  add(makeProp('SUMMARY', [], escapeText(input.title)))
  add(makeTimeProp('DTSTART', info, range.start))
  add(makeTimeProp('DTEND', info, range.end))
  if (input.recurrence) add(makeProp('RRULE', [], buildRule(input.recurrence, range, info, ctx)))
  if (input.status) add(makeProp('STATUS', [], STATUS_TEXT[input.status]))
  const names = (input.categoryNames ?? []).map((n) => n.trim()).filter(Boolean)
  if (names.length) add(makeProp('CATEGORIES', [], names.map(escapeText).join(',')))
  if (input.description) add(makeProp('DESCRIPTION', [], escapeText(input.description)))
  if (input.location) add(makeProp('LOCATION', [], escapeText(input.location)))

  const calendar: Comp = { kind: 'comp', name: 'VCALENDAR', beginRaw: '', endRaw: '', children: [] }
  calendar.children.push(
    makeProp('VERSION', [], '2.0'),
    makeProp('PRODID', [], PRODID),
    makeProp('CALSCALE', [], 'GREGORIAN'),
    event,
  )
  ensureTimezone(calendar, info, range.start)
  const root: Comp = { kind: 'comp', name: '', beginRaw: '', endRaw: '', children: [calendar] }
  return { uid, ics: serializeDocument(root) }
}
