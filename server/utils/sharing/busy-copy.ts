import { createHash } from 'node:crypto'
import {
  foldLine,
  parseDocument,
  parseLine,
  type Comp,
  type Prop,
} from '../../../app/utils/ical/write-lines'

// The "Busy" copy of an event, for a calendar shared at "Busy times only" (design §8): what a
// calendar app gets in place of the event, so it can sync the calendar like any other. It is built
// from nothing, from an allow-list, never by removing things from the original: when to, how it
// repeats, which occurrences are left out, and whether it is tentative. No title, description,
// place, people, alarm, category, attachment, URL or `X-` property, and no original UID or time
// stamp (a UID often holds an address or a host name, a stamp says when the event was edited). An
// event that free/busy leaves out (cancelled, or marked free) is left out here too: as a whole for
// the series, as an excluded date for one occurrence. Pure; the gateway (busy-view.ts) serves it.

/** One busy copy, as the calendar app sees it in the collection. */
export interface BusyEntry {
  /** The file name in the collection, `<hash>.ics`, from the original UID and the calendar. */
  name: string
  /** The entity tag, quoted, from the copy's text: an edit of something hidden changes nothing. */
  etag: string
  ics: string
}

/** The time stamp every copy carries, so neither the stamp nor the ETag tells when it was edited. */
const FIXED_DTSTAMP = '19700101T000000Z'

const DATE = String.raw`\d{8}`
const DATE_TIME = String.raw`\d{8}T\d{6}Z?`
const DURATION = String.raw`[+-]?P(?:\d+W|(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)`
const ONE_DATE = new RegExp(`^(?:${DATE_TIME}|${DATE})$`)
const DATE_LIST = new RegExp(`^(?:${DATE_TIME}|${DATE})(?:,(?:${DATE_TIME}|${DATE}))*$`)
const PERIOD = `${DATE_TIME}/(?:${DATE_TIME}|${DURATION})`
const RDATE_LIST = new RegExp(
  `^(?:${PERIOD}|${DATE_TIME}|${DATE})(?:,(?:${PERIOD}|${DATE_TIME}|${DATE}))*$`,
)
const DURATION_VALUE = new RegExp(`^${DURATION}$`)
/** A time zone name as clients write it: IANA ids, and Outlook's names with spaces and brackets. */
const TZID = /^[\w .+\-/()]{1,100}$/
const TZ_OFFSET = /^[+-]\d{4}(?:\d{2})?$/
const TZ_NAME = /^[\w+\- ]{1,32}$/
const RRULE_PARTS = new Set([
  'FREQ',
  'UNTIL',
  'COUNT',
  'INTERVAL',
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYDAY',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
])
const RRULE_VALUE = /^[A-Z0-9,+-]{1,200}$/

/** The parameters a kept date may carry, each checked; any other parameter is dropped. */
function dateParams(prop: Prop, allowRange: boolean): string[] | null {
  const kept: string[] = []
  for (const param of parseLine(prop).params) {
    const value = param.values[0] ?? ''
    if (param.values.length !== 1) continue
    if (param.name === 'TZID') {
      if (!TZID.test(value)) return null
      kept.push(`TZID=${value}`)
    } else if (param.name === 'VALUE') {
      const upper = value.toUpperCase()
      if (!['DATE', 'DATE-TIME', 'PERIOD'].includes(upper)) return null
      kept.push(`VALUE=${upper}`)
    } else if (param.name === 'RANGE' && allowRange && value.toUpperCase() === 'THISANDFUTURE') {
      kept.push('RANGE=THISANDFUTURE')
    }
  }
  return kept
}

function line(name: string, params: readonly string[], value: string): string {
  return foldLine(`${name}${params.map((param) => `;${param}`).join('')}:${value}`)
}

/** A date property rebuilt from its checked parts, or null when anything in it is off. */
function dateLine(
  prop: Prop,
  pattern: RegExp,
  options: { as?: string; allowRange?: boolean } = {},
): string | null {
  const parsed = parseLine(prop)
  if (!parsed.valid) return null
  const value = parsed.value.trim().toUpperCase()
  if (!pattern.test(value)) return null
  const params = dateParams(prop, options.allowRange === true)
  return params === null ? null : line(options.as ?? parsed.name, params, value)
}

function rruleLine(prop: Prop): string | null {
  const parsed = parseLine(prop)
  if (!parsed.valid || parsed.params.length > 0) return null
  const parts: string[] = []
  for (const part of parsed.value.trim().toUpperCase().split(';')) {
    const [key, value, extra] = part.split('=')
    if (extra !== undefined || !key || !value) return null
    if (!RRULE_PARTS.has(key) || !RRULE_VALUE.test(value)) return null
    parts.push(`${key}=${value}`)
  }
  return parts.some((part) => part.startsWith('FREQ=')) ? line('RRULE', [], parts.join(';')) : null
}

const propsNamed = (comp: Comp, name: string): Prop[] =>
  comp.children.filter((child): child is Prop => child.kind === 'prop' && child.name === name)
const compsNamed = (comp: Comp, name: string): Comp[] =>
  comp.children.filter((child): child is Comp => child.kind === 'comp' && child.name === name)
const valueOf = (prop: Prop | undefined): string =>
  prop ? parseLine(prop).value.trim().toUpperCase() : ''
const textOf = (comp: Comp | undefined, name: string): string => {
  const prop = comp ? propsNamed(comp, name)[0] : undefined
  return prop ? parseLine(prop).value.trim() : ''
}
const tzidOf = (zone: Comp): string => textOf(zone, 'TZID')

/** What free/busy leaves out: a cancelled event, or one marked free (transparent). */
function leftOut(event: Comp): boolean {
  return (
    valueOf(propsNamed(event, 'STATUS')[0]) === 'CANCELLED' ||
    valueOf(propsNamed(event, 'TRANSP')[0]) === 'TRANSPARENT'
  )
}

/** The busy VEVENT lines, or null when the event has no usable start. */
function busyEvent(event: Comp, uid: string, extraExdates: readonly string[]): string[] | null {
  const start = propsNamed(event, 'DTSTART')[0]
  const dtstart = start ? dateLine(start, ONE_DATE) : null
  if (dtstart === null) return null
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${FIXED_DTSTAMP}`, dtstart]
  const end = propsNamed(event, 'DTEND')[0]
  const duration = propsNamed(event, 'DURATION')[0]
  const dtend = end ? dateLine(end, ONE_DATE) : null
  if (dtend !== null) lines.push(dtend)
  else if (duration) {
    const value = valueOf(duration)
    if (DURATION_VALUE.test(value)) lines.push(`DURATION:${value}`)
  }
  const recurrence = propsNamed(event, 'RECURRENCE-ID')[0]
  if (recurrence) {
    const kept = dateLine(recurrence, ONE_DATE, { allowRange: true })
    if (kept === null) return null
    lines.push(kept)
  }
  for (const rule of propsNamed(event, 'RRULE').slice(0, 1)) {
    const kept = rruleLine(rule)
    if (kept !== null) lines.push(kept)
  }
  for (const rdate of propsNamed(event, 'RDATE')) {
    const kept = dateLine(rdate, RDATE_LIST)
    if (kept !== null) lines.push(kept)
  }
  for (const exdate of propsNamed(event, 'EXDATE')) {
    const kept = dateLine(exdate, DATE_LIST)
    if (kept !== null) lines.push(kept)
  }
  lines.push(...extraExdates)
  if (valueOf(propsNamed(event, 'STATUS')[0]) === 'TENTATIVE') lines.push('STATUS:TENTATIVE')
  lines.push('SUMMARY:Busy', 'END:VEVENT')
  return lines
}

/** A time zone the kept dates name, from its allow-list (no `X-` such as `X-LIC-LOCATION`). */
function busyTimezone(zone: Comp): string[] | null {
  const id = tzidOf(zone)
  if (!TZID.test(id)) return null
  const lines = ['BEGIN:VTIMEZONE', `TZID:${id}`]
  for (const part of zone.children) {
    if (part.kind !== 'comp' || (part.name !== 'STANDARD' && part.name !== 'DAYLIGHT')) continue
    const start = propsNamed(part, 'DTSTART')[0]
    const dtstart = start ? dateLine(start, ONE_DATE) : null
    const from = valueOf(propsNamed(part, 'TZOFFSETFROM')[0])
    const to = valueOf(propsNamed(part, 'TZOFFSETTO')[0])
    if (dtstart === null || !TZ_OFFSET.test(from) || !TZ_OFFSET.test(to)) continue
    const body = [`BEGIN:${part.name}`, dtstart, `TZOFFSETFROM:${from}`, `TZOFFSETTO:${to}`]
    const rule = propsNamed(part, 'RRULE')[0]
    const rrule = rule ? rruleLine(rule) : null
    if (rrule !== null) body.push(rrule)
    for (const rdate of propsNamed(part, 'RDATE')) {
      const kept = dateLine(rdate, RDATE_LIST)
      if (kept !== null) body.push(kept)
    }
    const name = propsNamed(part, 'TZNAME')[0]
    const tzname = name ? parseLine(name).value.trim() : ''
    if (TZ_NAME.test(tzname)) body.push(`TZNAME:${tzname}`)
    lines.push(...body, `END:${part.name}`)
  }
  lines.push('END:VTIMEZONE')
  return lines
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * The busy copy of one calendar object (the master of a series with its occurrences, or a single
 * event), or null when nothing of it is busy: no event, the series cancelled or free, or not
 * readable. `calendarId` keeps the hashed UID of one calendar apart from another's.
 */
export function busyCopy(calendarId: number, ics: string): BusyEntry | null {
  let root: Comp
  try {
    root = parseDocument(ics)
  } catch {
    return null
  }
  const calendar = compsNamed(root, 'VCALENDAR')[0]
  if (!calendar) return null
  const events = compsNamed(calendar, 'VEVENT')
  const uid = textOf(events[0], 'UID')
  if (events.length === 0 || uid === '') return null

  const master = events.find((event) => propsNamed(event, 'RECURRENCE-ID').length === 0)
  if (master && leftOut(master)) return null
  const hidden = `${hash(`${calendarId}\u0000${uid}`)}`
  const busyUid = `${hidden}@busy.web-calendar.invalid`
  // An occurrence that free/busy leaves out becomes an excluded date of the series.
  const extraExdates: string[] = []
  const occurrences: Comp[] = []
  for (const event of events) {
    if (event === master) continue
    if (!leftOut(event)) {
      occurrences.push(event)
      continue
    }
    const recurrence = propsNamed(event, 'RECURRENCE-ID')[0]
    const exdate = recurrence ? dateLine(recurrence, ONE_DATE, { as: 'EXDATE' }) : null
    if (master && exdate !== null) extraExdates.push(exdate)
  }
  const blocks: string[][] = []
  if (master) {
    const kept = busyEvent(master, busyUid, extraExdates)
    if (kept !== null) blocks.push(kept)
  }
  for (const occurrence of occurrences) {
    const kept = busyEvent(occurrence, busyUid, [])
    if (kept !== null) blocks.push(kept)
  }
  if (blocks.length === 0) return null

  // Only the time zones the kept dates name, each from its allow-list.
  const named = new Set<string>()
  for (const block of blocks) {
    for (const text of block) {
      const match = /^[A-Z-]+(?:;[^:]*)?;TZID=([^;:]+)/.exec(text.replace(/\r\n /g, ''))
      if (match) named.add(match[1]!)
    }
  }
  const zones: string[] = []
  for (const zone of compsNamed(calendar, 'VTIMEZONE')) {
    if (!named.has(tzidOf(zone))) continue
    const kept = busyTimezone(zone)
    if (kept !== null) zones.push(...kept)
  }

  const text = `${[
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-calendar//Busy times//EN',
    ...zones,
    ...blocks.flat(),
    'END:VCALENDAR',
  ].join('\r\n')}\r\n`
  return { name: `${hidden}.ics`, etag: `"${hash(text)}"`, ics: text }
}

/** The busy copies of a calendar's objects, by file name; objects without anything busy are left out. */
export function busyEntries(calendarId: number, objects: readonly string[]): BusyEntry[] {
  const entries = new Map<string, BusyEntry>()
  for (const object of objects) {
    const entry = busyCopy(calendarId, object)
    if (entry && !entries.has(entry.name)) entries.set(entry.name, entry)
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The sync token (and ctag) of a set of copies: it changes exactly when what the reader sees does. */
export function busyToken(entries: readonly BusyEntry[]): string {
  return `http://web-calendar.invalid/sync/busy/${hash(entries.map((e) => `${e.name}\u0000${e.etag}`).join('\n'))}`
}
