// The recurrence half of editing: which slots a series has, where an override or a split goes, and
// how EXDATE, RDATE and RRULE change when a series moves or is cut. Pure functions on the line
// model (write-lines.ts); ical.js does what it is good at, walking a rule's occurrences.
//
// Slots are wall-clock strings in DTSTART's own zone (a date for an all-day series). That is the
// space recurrence rules are defined in (RFC 5545 §3.3.10), so daylight saving never needs special
// handling while walking a rule. A slot's `id` is the contract string of
// `CalendarEvent.recurrenceId`: the UTC instant of the slot, or the date.
import ICAL from 'ical.js'
import {
  firstProp,
  parseLine,
  props,
  rawValue,
  rewriteProps,
  withParams,
  withValue,
  type Comp,
  type Prop,
} from './write-lines'
import {
  dateAddDays,
  daysBetween,
  formatTime,
  fromBasic,
  infoOf,
  isDateWall,
  periodStart,
  readTime,
  readTimeToken,
  sameInfo,
  toBasic,
  toBasicUtc,
  toIsoZ,
  wallAddSeconds,
  wallDiffSeconds,
  type TimeInfo,
  type TimeValue,
  type Zone,
  type ZoneResolver,
} from './write-zone'
import { EditError } from './write-types'

/** More slots than this are never walked; a rule that dense is not a calendar series. */
export const MAX_SLOTS = 60_000

export interface SeriesContext {
  /** The kind of time of the master's DTSTART. */
  info: TimeInfo
  readonly zone: Zone
  resolver: ZoneResolver
}

export interface Slot {
  wall: string
  id: string
}

/**
 * The series context of a component with a DTSTART. The zone is resolved on first use, so an event
 * in a zone nobody can resolve can still have its title edited.
 */
export function seriesContext(master: Comp, resolver: ZoneResolver): SeriesContext {
  const dtstart = firstProp(master, 'DTSTART')
  const time = dtstart ? readTime(dtstart) : null
  if (!time) throw new EditError('unparseable', 'The event has no readable DTSTART.')
  let zone: Zone | undefined
  return {
    info: time.info,
    resolver,
    get zone() {
      zone ??= resolver.zoneFor(time.info)
      return zone
    },
  }
}

export function slotIdOf(wall: string, ctx: SeriesContext): string {
  return ctx.info.kind === 'date' ? wall.slice(0, 10) : toIsoZ(ctx.zone.toInstant(wall))
}

/** True for an event that repeats: it has an RRULE or RDATE. */
export function isRecurring(master: Comp): boolean {
  return props(master, 'RRULE').length > 0 || props(master, 'RDATE').length > 0
}

// ---------------------------------------------------------------------------------------------
// Time values in the series' own wall clock

/** A time value as a wall clock in the series' zone (a date for an all-day series). */
export function masterWallOf(value: TimeValue, ctx: SeriesContext, startWall: string): string {
  if (ctx.info.kind === 'date') return value.wall.slice(0, 10)
  if (value.info.kind === 'date') return `${value.wall}T${startWall.slice(11)}`
  if (sameInfo(value.info, ctx.info)) return value.wall
  return ctx.zone.toWall(ctx.resolver.zoneFor(value.info).toInstant(value.wall))
}

/** The inverse of `masterWallOf` for a time in another zone than the series': same instant. */
export function wallInInfo(masterWall: string, info: TimeInfo, ctx: SeriesContext): string {
  if (info.kind === 'date') return masterWall.slice(0, 10)
  if (ctx.info.kind === 'date') return masterWall
  if (sameInfo(info, ctx.info)) return masterWall
  return ctx.resolver.zoneFor(info).toWall(ctx.zone.toInstant(masterWall))
}

/** The recurrence id (contract string) a RECURRENCE-ID, EXDATE or RDATE value names. */
export function idOfValue(value: TimeValue, ctx: SeriesContext): string {
  if (ctx.info.kind === 'date') return value.wall.slice(0, 10)
  if (value.info.kind === 'date') return value.wall
  return toIsoZ(ctx.resolver.zoneFor(value.info).toInstant(value.wall))
}

export function startWallOf(master: Comp): string {
  const dtstart = firstProp(master, 'DTSTART')
  const time = dtstart ? readTime(dtstart) : null
  if (!time) throw new EditError('unparseable', 'The event has no readable DTSTART.')
  return time.wall
}

/** The id of an override's RECURRENCE-ID, or null when it has none that can be read. */
export function overrideId(override: Comp, ctx: SeriesContext): string | null {
  const prop = firstProp(override, 'RECURRENCE-ID')
  const value = prop ? readTime(prop) : null
  return value ? idOfValue(value, ctx) : null
}

/** The time tokens of an EXDATE or RDATE line (periods are reduced to their start). */
function tokensOf(prop: Prop): string[] {
  return rawValue(prop)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Ids of the slots excluded by EXDATE. */
export function excludedIds(master: Comp, ctx: SeriesContext): Set<string> {
  const ids = new Set<string>()
  for (const prop of props(master, 'EXDATE')) {
    for (const token of tokensOf(prop)) {
      const value = readTimeToken(prop, token)
      if (value) ids.add(idOfValue(value, ctx))
    }
  }
  return ids
}

// ---------------------------------------------------------------------------------------------
// Rules

interface RuleSpec {
  prop: Prop
  recur: ICAL.Recur
  /** UNTIL as a wall clock of the series' zone; the rule ends after it. */
  untilWall: string | null
}

/** `FREQ=WEEKLY;BYDAY=MO` as ordered `[KEY, raw value]` pairs. */
export function ruleParts(value: string): Array<[string, string]> {
  return value
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      return eq < 0
        ? [part.toUpperCase(), '']
        : [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)]
    })
}

function untilWallOf(token: string, ctx: SeriesContext): string | null {
  const parsed = fromBasic(token)
  if (!parsed) return null
  if (ctx.info.kind === 'date') return parsed.wall.slice(0, 10)
  // A date UNTIL on a timed series includes that whole day.
  if (isDateWall(parsed.wall)) return `${parsed.wall}T23:59:59`
  return parsed.utc && ctx.info.kind !== 'utc'
    ? ctx.zone.toWall(Date.parse(`${parsed.wall}Z`))
    : parsed.wall
}

function readRules(master: Comp, ctx: SeriesContext): RuleSpec[] {
  return props(master, 'RRULE').map((prop) => {
    const value = rawValue(prop)
    let recur: ICAL.Recur
    try {
      recur = ICAL.Recur.fromString(value)
    } catch (error) {
      throw new EditError(
        'unparseable',
        `The recurrence rule ${value} cannot be read: ${String(error)}`,
      )
    }
    const until = ruleParts(value).find(([key]) => key === 'UNTIL')?.[1]
    // UNTIL is applied here, in the series' wall clock; ical.js would compare it to a floating time.
    recur.until = null
    return { prop, recur, untilWall: until ? untilWallOf(until, ctx) : null }
  })
}

/** Work limit for one step of a rule: ical.js searches for good when a rule can never match. */
const MAX_SCAN_STEPS = 100_000

/**
 * `RecurIterator` with a work limit. The loops that can spin forever call one of the
 * `next_<frequency>` methods on every turn, so counting those is enough.
 */
class GuardedIterator extends ICAL.RecurIterator {
  // `declare`: the base constructor already runs `init()`, which calls `next_year()`.
  declare scanSteps?: number

  private tick(): void {
    this.scanSteps = (this.scanSteps ?? 0) + 1
    if (this.scanSteps > MAX_SCAN_STEPS) throw new RangeError('the rule needs too much work')
  }

  override next(again = false): ICAL.Time {
    this.scanSteps = 0
    return super.next(again)
  }

  override next_second(): number {
    this.tick()
    return super.next_second()
  }

  override next_minute(): number {
    this.tick()
    return super.next_minute()
  }

  override next_hour(): number {
    this.tick()
    return super.next_hour()
  }

  override next_day(): number {
    this.tick()
    return super.next_day()
  }

  override next_week(): number {
    this.tick()
    return super.next_week()
  }

  override next_month(): number {
    this.tick()
    return super.next_month()
  }

  override next_year(): 0 | 1 {
    this.tick()
    return super.next_year()
  }
}

const BY_RANGES: Array<{ part: string; min: number; max: number; zero: boolean }> = [
  { part: 'BYSECOND', min: 0, max: 60, zero: true },
  { part: 'BYMINUTE', min: 0, max: 59, zero: true },
  { part: 'BYHOUR', min: 0, max: 23, zero: true },
  { part: 'BYMONTH', min: 1, max: 12, zero: false },
  { part: 'BYMONTHDAY', min: -31, max: 31, zero: false },
  { part: 'BYYEARDAY', min: -366, max: 366, zero: false },
  { part: 'BYWEEKNO', min: -53, max: 53, zero: false },
  { part: 'BYSETPOS', min: -366, max: 366, zero: false },
]
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Why a rule cannot be walked safely, or null: what makes ical.js loop without end or throw. */
function ruleProblem(rule: ICAL.Recur, text: string): string | null {
  // ical.js reads INTERVAL=0 as 1; the rule as written is invalid.
  const interval = ruleParts(text).find(([key]) => key === 'INTERVAL')?.[1]
  if (interval !== undefined && !/^[1-9]\d*$/.test(interval)) return 'INTERVAL must be 1 or more'
  if (!Number.isInteger(rule.interval) || rule.interval < 1) return 'INTERVAL must be 1 or more'
  if (rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1)) {
    return 'COUNT must be 1 or more'
  }
  for (const { part, min, max, zero } of BY_RANGES) {
    for (const value of rule.getComponent(part)) {
      const n = Number(value)
      if (!Number.isInteger(n) || n < min || n > max || (n === 0 && !zero)) {
        return `${part} has the invalid value ${String(value)}`
      }
    }
  }
  const months = rule.getComponent('BYMONTH').map(Number)
  const days = rule.getComponent('BYMONTHDAY').map(Number)
  if (months.length && days.length) {
    // The 30th of February: no day ever matches.
    const possible = months.some((month) =>
      days.some((day) => Math.abs(day) <= (MAX_DAYS_IN_MONTH[month - 1] ?? 0)),
    )
    if (!possible) return 'BYMONTH and BYMONTHDAY never match'
  }
  return null
}

function* ruleWalls(spec: RuleSpec, startWall: string): Generator<string> {
  const date = isDateWall(startWall)
  const start = date ? ICAL.Time.fromDateString(startWall) : ICAL.Time.fromDateTimeString(startWall)
  const problem = ruleProblem(spec.recur, rawValue(spec.prop))
  if (problem) throw unreadableRule(spec, problem)
  // ical.js accepts some rules it cannot walk (a rule without FREQ) and fails with a TypeError.
  let iterator: GuardedIterator
  try {
    iterator = new GuardedIterator({ rule: spec.recur, dtstart: start })
  } catch (error) {
    throw unreadableRule(spec, error)
  }
  // ical.js moves 29 February to 1 March in the years without it; RFC 5545 §3.3.10 says such an
  // instance does not exist, and the calendar view leaves it out too.
  const keepsDay =
    spec.recur.freq === 'YEARLY' &&
    !['BYMONTHDAY', 'BYDAY', 'BYYEARDAY', 'BYWEEKNO'].some(
      (part) => spec.recur.getComponent(part).length,
    )
  for (let i = 0; i < MAX_SLOTS; i++) {
    let time: ICAL.Time | null
    try {
      time = iterator.next()
    } catch (error) {
      throw unreadableRule(spec, error)
    }
    if (!time) return
    const wall = date ? time.toString().slice(0, 10) : time.toString().slice(0, 19)
    if (spec.untilWall !== null && wall > spec.untilWall) return
    if (keepsDay && wall.slice(8, 10) !== startWall.slice(8, 10)) continue
    yield wall
  }
}

function unreadableRule(spec: RuleSpec, error: unknown): EditError {
  return new EditError(
    'unparseable',
    `The recurrence rule ${rawValue(spec.prop)} cannot be walked: ${String(error)}`,
  )
}

/** RDATE starts as walls of the series' zone. */
function rdateWalls(master: Comp, ctx: SeriesContext, startWall: string): string[] {
  const walls: string[] = []
  for (const prop of props(master, 'RDATE')) {
    for (const token of tokensOf(prop)) {
      const value = readTimeToken(prop, token)
      if (value) walls.push(masterWallOf(value, ctx, startWall))
    }
  }
  return walls
}

/**
 * Every slot of a series in time order, EXDATE not applied: DTSTART, the occurrences of every RRULE
 * and the RDATEs. DTSTART always counts as a slot (RFC 5545 §3.8.5.3), also when the rule would not
 * produce it, as the calendar view reads it. (ical.js leaves such a DTSTART out of its own
 * expansion; COUNT is counted on the rule's own occurrences, as ical.js does.)
 */
export function* slotStream(master: Comp, ctx: SeriesContext): Generator<Slot> {
  const startWall = startWallOf(master)
  const rules = readRules(master, ctx)
  const fixed = [...new Set([startWall, ...rdateWalls(master, ctx, startWall)])].sort()
  const generators = rules.map((spec) => ruleWalls(spec, startWall))
  const heads = generators.map((generator) => generator.next())
  let fixedIndex = 0
  let last = ''
  for (let emitted = 0; emitted < MAX_SLOTS;) {
    let best: string | null = fixedIndex < fixed.length ? fixed[fixedIndex]! : null
    let source = -1
    for (let index = 0; index < heads.length; index++) {
      const head = heads[index]!
      if (!head.done && (best === null || head.value < best)) {
        best = head.value
        source = index
      }
    }
    if (best === null) return
    if (source < 0) fixedIndex++
    else heads[source] = generators[source]!.next()
    if (best === last) continue
    last = best
    emitted++
    yield { wall: best, id: slotIdOf(best, ctx) }
  }
}

export interface SlotLookup {
  slot: Slot
  excluded: boolean
  /** True when an occurrence (a slot not excluded by EXDATE) comes before this one. */
  hasEarlierOccurrence: boolean
}

/** Finds the slot a recurrence id names; null when it is not a slot of the series. */
export function lookupSlot(
  master: Comp,
  ctx: SeriesContext,
  id: string,
  excluded: Set<string>,
): SlotLookup | null {
  let hasEarlierOccurrence = false
  for (const slot of slotStream(master, ctx)) {
    if (slot.id === id) return { slot, excluded: excluded.has(id), hasEarlierOccurrence }
    if (slot.id > id) return null
    if (!excluded.has(slot.id)) hasEarlierOccurrence = true
  }
  return null
}

/** True when the series still has at least one occurrence (a slot EXDATE does not exclude). */
export function hasOccurrence(master: Comp, ctx: SeriesContext, excluded: Set<string>): boolean {
  for (const slot of slotStream(master, ctx)) {
    if (!excluded.has(slot.id)) return true
  }
  return false
}

/** How many occurrences one RRULE produces before `targetWall` (the part of COUNT already used). */
export function ruleSlotsBefore(
  master: Comp,
  ctx: SeriesContext,
  rule: Prop,
  targetWall: string,
): number {
  const spec = readRules(master, ctx).find((r) => r.prop === rule)
  if (!spec) return 0
  let count = 0
  for (const wall of ruleWalls(spec, startWallOf(master))) {
    if (wall >= targetWall) break
    count++
  }
  return count
}

// ---------------------------------------------------------------------------------------------
// Editing a rule

export interface RuleEdit {
  /** `null` removes COUNT, a number replaces it. */
  count?: number | null
  /** A new UNTIL token (written form); replaces COUNT-free UNTIL or adds one. */
  until?: string
  /** Rewrites an existing UNTIL token (a series that moves). */
  mapUntil?: (token: string) => string
  /** Days to shift the weekdays of a weekly rule by (a series moved to another weekday). */
  byDayShift?: number
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function shiftWeekday(entry: string, shift: number): string {
  const match = /^([A-Z]{2})$/i.exec(entry.trim())
  if (!match) return entry // an ordinal such as 1MO or -1FR cannot follow a plain day shift
  const index = WEEKDAYS.indexOf(match[1]!.toUpperCase())
  return index < 0 ? entry : WEEKDAYS[(((index + shift) % 7) + 7) % 7]!
}

/**
 * The RRULE with the edit applied. Every part the edit does not name keeps its text and its place,
 * so `BYSETPOS`, `WKST` and the rest come back as they were written. The same property object is
 * returned when nothing changed.
 */
export function editRule(prop: Prop, edit: RuleEdit): Prop {
  const parts = rawValue(prop).split(';').filter(Boolean)
  const keyOf = (part: string): string => part.split('=')[0]!.toUpperCase()
  const freq = parts
    .find((p) => keyOf(p) === 'FREQ')
    ?.split('=')[1]
    ?.toUpperCase()
  let out = parts.map((part) => {
    const key = keyOf(part)
    const value = part.slice(part.indexOf('=') + 1)
    if (key === 'UNTIL' && edit.mapUntil) return `UNTIL=${edit.mapUntil(value)}`
    if (key === 'BYDAY' && edit.byDayShift && freq === 'WEEKLY') {
      return `BYDAY=${value
        .split(',')
        .map((entry) => shiftWeekday(entry, edit.byDayShift!))
        .join(',')}`
    }
    return part
  })
  if (edit.count !== undefined) out = out.filter((p) => keyOf(p) !== 'COUNT')
  if (typeof edit.count === 'number') out.push(`COUNT=${edit.count}`)
  if (edit.until !== undefined) {
    const index = out.findIndex((p) => keyOf(p) === 'UNTIL')
    if (index >= 0) out[index] = `UNTIL=${edit.until}`
    else out.push(`UNTIL=${edit.until}`)
  }
  const value = out.join(';')
  return value === rawValue(prop) ? prop : withValue(prop, value)
}

/** The COUNT of a rule, or null. */
export function ruleCount(prop: Prop): number | null {
  const count = ruleParts(rawValue(prop)).find(([key]) => key === 'COUNT')?.[1]
  const n = count === undefined ? NaN : Number.parseInt(count, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * The UNTIL that ends a series just before `slot`: one second earlier, in the form RFC 5545 §3.3.10
 * wants for the series' DTSTART (UTC for a zoned or UTC time, floating for floating, the previous
 * day for a date).
 */
export function untilBefore(slot: Slot, ctx: SeriesContext): string {
  switch (ctx.info.kind) {
    case 'date':
      return toBasic(dateAddDays(slot.wall, -1))
    case 'floating':
      return toBasic(wallAddSeconds(slot.wall, -1))
    default:
      return toBasicUtc(ctx.zone.toInstant(slot.wall) - 1000)
  }
}

// ---------------------------------------------------------------------------------------------
// Moving a series

/** How the slots of a series move when its first start does. */
export interface SlotMap {
  newInfo: TimeInfo
  kindChanged: boolean
  /** True when no slot moves and the kind of time stays. */
  identity: boolean
  /** Whole days between the old and the new anchor date, for weekly BYDAY. */
  dayShift: number
  apply(wall: string): string
}

/**
 * The map from old slots to new ones. `from` is the anchor's old start (a wall clock of the old
 * kind), `to` its new start (of the new kind). Timed to timed moves every slot by the same wall-clock
 * seconds; dates move by days; a switch between a date and a time keeps the date arithmetic and
 * takes the new time of day (or drops it).
 */
export function makeSlotMap(
  oldInfo: TimeInfo,
  newInfo: TimeInfo,
  from: string,
  to: string,
): SlotMap {
  const oldDate = oldInfo.kind === 'date'
  const newDate = newInfo.kind === 'date'
  const dayShift = daysBetween(from, to)
  const kindChanged = !sameInfo(oldInfo, newInfo)
  let apply: (wall: string) => string
  if (oldDate && newDate) apply = (wall) => dateAddDays(wall, dayShift)
  else if (!oldDate && !newDate) {
    const seconds = wallDiffSeconds(from, to)
    apply = (wall) => wallAddSeconds(wall, seconds)
  } else if (oldDate) {
    const time = to.slice(10)
    apply = (wall) => `${dateAddDays(wall, dayShift)}${time}`
  } else apply = (wall) => dateAddDays(wall.slice(0, 10), dayShift)
  return { newInfo, kindChanged, identity: !kindChanged && apply(from) === from, dayShift, apply }
}

/** A map that moves nothing. */
export function identityMap(info: TimeInfo): SlotMap {
  return { newInfo: info, kindChanged: false, identity: true, dayShift: 0, apply: (wall) => wall }
}

export interface TimeListEdit {
  /** Keeps a token when it returns true (by the token's wall in the series' zone and its id). */
  keep?: (wall: string, id: string) => boolean
  map?: SlotMap
  /** The zone the mapped walls are in (the series' zone after the move). */
  newZone?: Zone
}

/**
 * Rewrites an EXDATE or RDATE line token by token: drops tokens `keep` refuses and moves the others
 * with `map`. Returns the property itself when nothing changed, null when no token is left.
 */
export function transformTimeList(
  prop: Prop,
  ctx: SeriesContext,
  startWall: string,
  edit: TimeListEdit,
): Prop | null {
  const tokens = tokensOf(prop)
  const lineInfo = infoOf(prop, periodStart(tokens[0] ?? ''))
  const out: string[] = []
  let changed = false
  let outInfo = lineInfo
  for (const token of tokens) {
    const value = readTimeToken(prop, token)
    if (!value) {
      out.push(token)
      continue
    }
    const wall = masterWallOf(value, ctx, startWall)
    const id = idOfValue(value, ctx)
    if (edit.keep && !edit.keep(wall, id)) {
      changed = true
      continue
    }
    if (!edit.map || edit.map.identity) {
      out.push(token)
      continue
    }
    const mapPart = (part: string): string => {
      const time = readTimeToken(prop, part)
      if (!time) return part
      const mapped = edit.map!.apply(masterWallOf(time, ctx, startWall))
      const targetInfo = edit.map!.kindChanged ? edit.map!.newInfo : time.info
      const targetWall = edit.map!.kindChanged ? mapped : wallInInfo(mapped, time.info, ctx)
      outInfo = targetInfo
      return formatTime(targetInfo, targetWall).value
    }
    const slash = token.indexOf('/')
    let rewritten: string
    if (slash < 0) rewritten = mapPart(token)
    else {
      const rest = token.slice(slash + 1)
      rewritten = `${mapPart(token.slice(0, slash))}/${fromBasic(rest) ? mapPart(rest) : rest}`
    }
    out.push(rewritten)
    changed = true
  }
  if (!changed) return prop
  if (out.length === 0) return null
  const value = out.join(',')
  if (edit.map && edit.map.kindChanged && !sameInfo(lineInfo, outInfo)) {
    const drop = ['TZID']
    const type = parseLine(prop)
      .params.find((p) => p.name === 'VALUE')
      ?.values[0]?.toUpperCase()
    if (type === 'DATE' || type === 'DATE-TIME') drop.push('VALUE')
    const params = formatTime(outInfo, '2000-01-01T00:00:00').params.filter(
      (p) => !p.startsWith('VALUE=') || outInfo.kind === 'date',
    )
    return withValue(withParams(prop, drop, params), value)
  }
  return withValue(prop, value)
}

/** The UNTIL token of a rule after the series moved. */
export function mapUntilToken(
  token: string,
  ctx: SeriesContext,
  map: SlotMap,
  newZone: Zone,
): string {
  const wall = untilWallOf(token, ctx)
  if (wall === null || map.identity) return token
  const mapped = map.apply(wall)
  switch (map.newInfo.kind) {
    case 'date':
      return toBasic(mapped.slice(0, 10))
    case 'floating':
      return toBasic(mapped)
    default:
      return toBasicUtc(newZone.toInstant(mapped))
  }
}

// ---------------------------------------------------------------------------------------------
// Cutting a series

/**
 * Ends the series just before `slot` and drops what lies at or after it: every RRULE gets
 * `UNTIL` (and loses `COUNT`), EXDATE and RDATE entries from the slot on are removed.
 */
export function truncateSeries(master: Comp, slot: Slot, ctx: SeriesContext): void {
  const startWall = startWallOf(master)
  const until = untilBefore(slot, ctx)
  rewriteProps(master, 'RRULE', (prop) => editRule(prop, { count: null, until }))
  const keep = (_wall: string, id: string): boolean => id < slot.id
  rewriteProps(master, 'EXDATE', (prop) => transformTimeList(prop, ctx, startWall, { keep }))
  rewriteProps(master, 'RDATE', (prop) => transformTimeList(prop, ctx, startWall, { keep }))
}

/**
 * True when the series hangs together: every RRULE starts on DTSTART, and every override and every
 * EXDATE names a slot of the series. A move by whole days keeps a rule that follows DTSTART
 * (a weekly one, after BYDAY is shifted) in this state; one that does not (a monthly BYSETPOS, a
 * numbered weekday) leaves DTSTART off the rule and the overrides and exclusions pointing at
 * non-slots, which is the signal to refuse the move.
 */
export function isConsistent(master: Comp, overrides: Comp[], resolver: ZoneResolver): boolean {
  const ctx = seriesContext(master, resolver)
  const startWall = startWallOf(master)
  for (const spec of readRules(master, ctx)) {
    if (ruleWalls(spec, startWall).next().value !== startWall) return false
  }
  const wanted = new Set<string>(excludedIds(master, ctx))
  for (const override of overrides) {
    const id = overrideId(override, ctx)
    if (id !== null) wanted.add(id)
  }
  if (wanted.size === 0) return true
  const last = [...wanted].sort().pop()!
  for (const slot of slotStream(master, ctx)) {
    wanted.delete(slot.id)
    if (wanted.size === 0) return true
    if (slot.id > last) break
  }
  return wanted.size === 0
}
