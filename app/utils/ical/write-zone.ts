// Wall-clock arithmetic and time zones for the write side. An iCalendar time is one of four things:
// a date, a UTC instant, a floating wall clock, or a wall clock in a named zone (TZID). Recurrence
// rules run on the wall clock of DTSTART's own zone, so slots are wall-clock strings and a zone is
// only needed to name the instant behind one (the recurrence id) or to move a time between zones.
import ICAL from 'ical.js'
import { Temporal } from 'temporal-polyfill'
import { isValidTimeZone } from '../../../shared/utils/time-zone'
import {
  componentText,
  firstProp,
  makeProp,
  paramValue,
  parseLine,
  stripControl,
  subcomponents,
  type Comp,
  type Prop,
} from './write-lines'
import { t } from '../i18n'
import { EditError } from './write-types'

export type TimeInfo =
  { kind: 'date' } | { kind: 'utc' } | { kind: 'floating' } | { kind: 'zoned'; tzid: string }

/** A time as written in a property, before any conversion. `wall` is `YYYY-MM-DD[THH:mm:ss]`. */
export interface TimeValue {
  info: TimeInfo
  wall: string
}

/** Moves between wall-clock strings and instants for one zone (RFC 5545 §3.3.5 for odd local times). */
export interface Zone {
  /** The instant (epoch milliseconds) a wall clock `YYYY-MM-DDTHH:mm:ss` stands for. */
  toInstant(wall: string): number
  toWall(ms: number): string
}

export function sameInfo(a: TimeInfo, b: TimeInfo): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'zoned' || (b.kind === 'zoned' && a.tzid === b.tzid)
}

// ---------------------------------------------------------------------------------------------
// Wall-clock strings

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/

export type WallPart = 'start' | 'end' | 'until'

/** The words for a wall clock that is not a date or time (`invalid`: it has the form but not a real value). */
function wallProblem(what: WallPart, value: string, invalid: boolean): string {
  if (invalid) {
    if (what === 'start') return t('The start is not a valid date or time: {value}', { value })
    if (what === 'end') return t('The end is not a valid date or time: {value}', { value })
    return t('The end of the series is not a valid date or time: {value}', { value })
  }
  if (what === 'start') return t('The start is not a date or date-time: {value}', { value })
  if (what === 'end') return t('The end is not a date or date-time: {value}', { value })
  return t('The end of the series is not a date or date-time: {value}', { value })
}

/**
 * Checks and normalizes a wall clock: `YYYY-MM-DD` stays a date, `YYYY-MM-DDTHH:mm[:ss]` becomes
 * `YYYY-MM-DDTHH:mm:ss`. Throws an `invalid-input` error for anything else, including 30 February.
 */
export function normalizeWall(value: string, what: WallPart): string {
  const match = WALL_RE.exec(value)
  if (!match) throw new EditError('invalid-input', wallProblem(what, value, false))
  try {
    if (match[4] === undefined)
      return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString()
    return Temporal.PlainDateTime.from(`${value.length === 16 ? `${value}:00` : value}`, {
      overflow: 'reject',
    }).toString({ smallestUnit: 'second' })
  } catch {
    throw new EditError('invalid-input', wallProblem(what, value, true))
  }
}

export function isDateWall(wall: string): boolean {
  return wall.length === 10
}

/** A wall clock read as if it were UTC, so plain arithmetic never meets a daylight-saving change. */
function wallMs(wall: string): number {
  return Date.parse(isDateWall(wall) ? `${wall}T00:00:00Z` : `${wall}Z`)
}

function msWall(ms: number, date: boolean): string {
  const iso = new Date(ms).toISOString()
  return date ? iso.slice(0, 10) : iso.slice(0, 19)
}

export function wallAddSeconds(wall: string, seconds: number): string {
  return msWall(wallMs(wall) + seconds * 1000, isDateWall(wall))
}

export function wallDiffSeconds(from: string, to: string): number {
  return Math.round((wallMs(to) - wallMs(from)) / 1000)
}

export function dateAddDays(date: string, days: number): string {
  return msWall(wallMs(date.slice(0, 10)) + days * 86_400_000, true)
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((wallMs(toDate.slice(0, 10)) - wallMs(fromDate.slice(0, 10))) / 86_400_000)
}

/** `2026-10-25T03:00:00` -> `20261025T030000`; `2026-10-25` -> `20261025`. */
export function toBasic(wall: string): string {
  return wall.replace(/[-:]/g, '')
}

/** `20261025T030000[Z]` -> a wall clock and whether it was UTC; null when malformed. */
export function fromBasic(value: string): { wall: string; utc: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(value.trim())
  if (!match) return null
  const date = `${match[1]}-${match[2]}-${match[3]}`
  if (match[4] === undefined) return { wall: date, utc: false }
  return { wall: `${date}T${match[4]}:${match[5]}:${match[6]}`, utc: match[7] !== undefined }
}

/** An instant as the UTC form of iCalendar (`20261025T010000Z`). */
export function toBasicUtc(ms: number): string {
  return `${toBasic(msWall(ms, false))}Z`
}

/** An instant as the recurrence-id contract string (`2026-10-25T01:00:00Z`). */
export function toIsoZ(ms: number): string {
  return `${msWall(ms, false)}Z`
}

// ---------------------------------------------------------------------------------------------
// Time values in properties

/** The kind of time a property holds, from its `VALUE`, `TZID` parameters and the value itself. */
export function infoOf(prop: Prop, value: string): TimeInfo {
  const type = paramValue(prop, 'VALUE')?.toUpperCase()
  const tzid = paramValue(prop, 'TZID')
  if (type === 'DATE' || (type === undefined && !value.includes('T') && !value.includes('t'))) {
    return { kind: 'date' }
  }
  if (value.endsWith('Z') || value.endsWith('z')) return { kind: 'utc' }
  return tzid ? { kind: 'zoned', tzid } : { kind: 'floating' }
}

/** The start of a time token: the token itself, or the part of a PERIOD before the slash. */
export function periodStart(token: string): string {
  const slash = token.indexOf('/')
  return slash < 0 ? token : token.slice(0, slash)
}

/** Reads one time token of a property. Null when it is not a date or date-time. */
export function readTimeToken(prop: Prop, token: string): TimeValue | null {
  // A PERIOD (`20261201T090000Z/PT1H`) starts where its first part says.
  const start = periodStart(token)
  const parsed = fromBasic(start)
  if (!parsed) return null
  const info = infoOf(prop, start)
  return { info: isDateWall(parsed.wall) ? { kind: 'date' } : info, wall: parsed.wall }
}

/** The first time of a property (DTSTART, DTEND, RECURRENCE-ID). */
export function readTime(prop: Prop): TimeValue | null {
  return readTimeToken(prop, parseLine(prop).value.split(',')[0]!)
}

/** The written form of a time value: the value and the parameters that describe it. */
export function formatTime(info: TimeInfo, wall: string): { params: string[]; value: string } {
  switch (info.kind) {
    case 'date':
      return { params: ['VALUE=DATE'], value: toBasic(wall.slice(0, 10)) }
    case 'utc':
      return { params: [], value: `${toBasic(wall)}Z` }
    case 'floating':
      return { params: [], value: toBasic(wall) }
    case 'zoned':
      return { params: [`TZID=${tzidParam(info.tzid)}`], value: toBasic(wall) }
  }
}

function tzidParam(tzid: string): string {
  const clean = stripControl(tzid).replace(/"/g, '')
  return /[;:,]/.test(clean) ? `"${clean}"` : clean
}

/** A time property built from scratch. */
export function makeTimeProp(name: string, info: TimeInfo, wall: string): Prop {
  const { params, value } = formatTime(info, wall)
  return makeProp(name, params, value)
}

/**
 * The property with a new time. Parameters that do not describe the time (`RANGE`, `X-...`) are
 * kept; when the kind of time is unchanged so are `TZID` and `VALUE`, exactly as written.
 */
export function withTime(prop: Prop, oldInfo: TimeInfo, info: TimeInfo, wall: string): Prop {
  const { params, value } = formatTime(info, wall)
  const parsed = parseLine(prop)
  if (sameInfo(oldInfo, info)) {
    return {
      kind: 'prop',
      name: prop.name,
      text: prop.text.slice(0, parsed.valueStart) + value,
      raw: null,
    }
  }
  const kept = parsed.params
    .filter((p) => p.name !== 'TZID' && p.name !== 'VALUE')
    .map((p) => p.raw)
  return makeProp(prop.name, [...params, ...kept], value)
}

// ---------------------------------------------------------------------------------------------
// Zones

function ianaZone(name: string): Zone {
  return {
    toInstant: (wall) =>
      Temporal.PlainDateTime.from(wall).toZonedDateTime(name, { disambiguation: 'compatible' })
        .epochMilliseconds,
    toWall: (ms) =>
      Temporal.Instant.fromEpochMilliseconds(ms)
        .toZonedDateTimeISO(name)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' }),
  }
}

/** A zone that exists only as a VTIMEZONE in the file (Outlook's `W. Europe Standard Time`). */
function vtimezoneZone(vtimezone: Comp): Zone {
  const tz = new ICAL.Timezone(ICAL.Component.fromString(componentText(vtimezone)))
  return {
    toInstant: (wall) => {
      const time = ICAL.Time.fromDateTimeString(wall)
      time.zone = tz
      return time.toUnixTime() * 1000
    },
    toWall: (ms) =>
      ICAL.Time.fromJSDate(new Date(ms), true).convertToZone(tz).toString().slice(0, 19),
  }
}

/**
 * The IANA name behind a TZID, or null. Some clients write `/mozilla.org/20050126_1/Europe/Berlin`;
 * the zone is what remains after the leading path segments.
 */
export function ianaNameOf(tzid: string): string | null {
  if (isValidTimeZone(tzid)) return tzid
  if (!tzid.startsWith('/')) return null
  const segments = tzid.split('/').filter(Boolean)
  for (let i = 1; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/')
    if (candidate.includes('/') && isValidTimeZone(candidate)) return candidate
  }
  return null
}

const UTC_ZONE = ianaZone('UTC')

/** Resolves the zone of a time: IANA names first, then the VTIMEZONE the file carries. */
export class ZoneResolver {
  private readonly cache = new Map<string, Zone>()

  constructor(
    private readonly calendar: Comp,
    private readonly orgTimeZone: string,
  ) {}

  zoneFor(info: TimeInfo): Zone {
    switch (info.kind) {
      case 'date':
      case 'utc':
        return UTC_ZONE
      case 'floating':
        return this.named(this.orgTimeZone)
      case 'zoned':
        return this.zoned(info.tzid)
    }
  }

  private named(name: string): Zone {
    let zone = this.cache.get(name)
    if (!zone) {
      zone = ianaZone(name)
      this.cache.set(name, zone)
    }
    return zone
  }

  private zoned(tzid: string): Zone {
    const cached = this.cache.get(`tzid:${tzid}`)
    if (cached) return cached
    const iana = ianaNameOf(tzid)
    let zone: Zone | undefined = iana ? ianaZone(iana) : undefined
    if (!zone) {
      const vtimezone = subcomponents(this.calendar, 'VTIMEZONE').find(
        (c) => firstProp(c, 'TZID') && parseLine(firstProp(c, 'TZID')!).value === tzid,
      )
      if (vtimezone) {
        try {
          zone = vtimezoneZone(vtimezone)
        } catch {
          zone = undefined
        }
      }
    }
    if (!zone) {
      throw new EditError(
        'unsupported',
        t(
          'The time zone {tzid} is not an IANA zone and the calendar has no usable VTIMEZONE for it.',
          { tzid },
        ),
      )
    }
    this.cache.set(`tzid:${tzid}`, zone)
    return zone
  }
}

/** The zone of a named IANA zone (for the editor's display zone). */
export function zoneNamed(name: string): Zone {
  return ianaZone(name)
}
