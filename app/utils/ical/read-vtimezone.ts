// A VTIMEZONE of an .ics file as ZoneRules (UTC offset at an instant).
//
// ical.js has its own `Timezone` for this, but it reads a repeated or missing local time the other
// way round than RFC 5545 §3.3.5 (and than `convertWallClock`): in the hour the clocks go back it
// picks the second occurrence, and in the gap it uses the new offset. So only ical.js's parser and
// rule evaluation are used here; the transitions are turned into instants and `wallToInstant` in
// zone.ts decides. Parsing a VTIMEZONE (an Outlook one starts in 1601) costs milliseconds, so the
// result is kept per VTIMEZONE text; a read of many resources shares it.
import ICAL from 'ical.js'
import { RecurrenceError, ruleWalls } from './read-recur'
import { type ZoneRules, wallFromFields } from './zone'

interface Observance {
  /** TZOFFSETFROM and TZOFFSETTO in seconds. */
  from: number
  to: number
  /** DTSTART: the first onset, a wall time in the offset in force before it. */
  start: number
  /** RDATE onsets, same reading. */
  rdates: number[]
  rules: { rule: ICAL.Recur; untilWall: number | null }[]
}

interface Transition {
  /** The instant the offset changes. */
  at: number
  from: number
  to: number
}

const OFFSET = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/
const ONSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/

function parseOffset(value: unknown): number | null {
  const match = typeof value === 'string' ? OFFSET.exec(value) : null
  if (!match) return null
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)
  return match[1] === '-' ? -seconds : seconds
}

function parseOnset(value: unknown): number | null {
  const match = typeof value === 'string' ? ONSET.exec(value) : null
  if (!match) return null
  return wallFromFields(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function readObservance(component: ICAL.Component): Observance | null {
  const from = parseOffset(component.getFirstProperty('tzoffsetfrom')?.jCal[3])
  const to = parseOffset(component.getFirstProperty('tzoffsetto')?.jCal[3])
  const start = parseOnset(component.getFirstProperty('dtstart')?.jCal[3])
  if (from === null || to === null || start === null) return null
  const rdates: number[] = []
  for (const property of component.getAllProperties('rdate')) {
    for (const value of property.jCal.slice(3)) {
      const onset = parseOnset(value)
      if (onset !== null) rdates.push(onset)
    }
  }
  const rules: Observance['rules'] = []
  for (const property of component.getAllProperties('rrule')) {
    const rule = property.getFirstValue()
    if (!(rule instanceof ICAL.Recur)) continue
    // UNTIL is UTC; ical.js compares it with the local onsets, so move it into the local reading.
    let untilWall: number | null = null
    if (rule.until) {
      const until = wallFromFields(
        rule.until.year,
        rule.until.month,
        rule.until.day,
        rule.until.hour,
        rule.until.minute,
        rule.until.second,
      )
      const utc = rule.until.zone?.tzid === 'UTC'
      untilWall = until === null ? null : utc ? until + from * 1000 : until
    }
    rules.push({ rule, untilWall })
  }
  return { from, to, start, rdates, rules }
}

const EPOCH_1970 = Date.UTC(1970, 0, 1)
/** A runaway rule in a VTIMEZONE stops after this many onsets. */
const MAX_ONSETS_PER_RULE = 2000

function transitionsUntil(observances: Observance[], lastYear: number): Transition[] {
  const transitions: Transition[] = []
  for (const observance of observances) {
    const add = (wall: number): void => {
      transitions.push({
        at: wall - observance.from * 1000,
        from: observance.from,
        to: observance.to,
      })
    }
    add(observance.start)
    for (const rdate of observance.rdates) add(rdate)
    for (const { rule, untilWall } of observance.rules) {
      let seen = 0
      try {
        // Nothing before 1970 is needed, so an Outlook rule that begins in 1601 skips ahead.
        for (const wall of ruleWalls({
          rule,
          startWall: observance.start,
          isDate: false,
          untilWall,
          fromWall: EPOCH_1970,
        })) {
          if (new Date(wall).getUTCFullYear() > lastYear || ++seen > MAX_ONSETS_PER_RULE) break
          if (wall !== observance.start) add(wall)
        }
      } catch (error) {
        // A rule that cannot be evaluated keeps the observance's first onset only.
        if (!(error instanceof RecurrenceError)) throw error
      }
    }
  }
  return transitions.sort((a, b) => a.at - b.at)
}

/** Years past the one asked for that are computed in advance. */
const LOOKAHEAD_YEARS = 6

function buildRules(id: string, observances: Observance[]): ZoneRules {
  let transitions: Transition[] = []
  let coveredYear = Number.NEGATIVE_INFINITY
  const first = observances.reduce((a, b) =>
    a.start - a.from * 1000 <= b.start - b.from * 1000 ? a : b,
  )
  return {
    id,
    offsetAt(epochMs) {
      const year = new Date(epochMs).getUTCFullYear()
      if (year > coveredYear) {
        coveredYear = Math.max(year, new Date().getUTCFullYear()) + LOOKAHEAD_YEARS
        transitions = transitionsUntil(observances, coveredYear)
      }
      // Binary search for the last transition at or before the instant.
      let low = 0
      let high = transitions.length - 1
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if ((transitions[mid] as Transition).at <= epochMs) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      // Before the first onset the zone has the offset that onset replaces.
      return found >= 0 ? (transitions[found] as Transition).to : first.from
    },
  }
}

const cache = new Map<string, ZoneRules | null>()
const CACHE_LIMIT = 64

/** The rules of a VTIMEZONE; null when it holds no usable STANDARD or DAYLIGHT part. */
export function zoneFromVtimezone(component: ICAL.Component): ZoneRules | null {
  const tzid = String(component.getFirstPropertyValue('tzid') ?? '')
  const key = JSON.stringify(component.toJSON())
  if (cache.has(key)) return cache.get(key) ?? null
  const observances: Observance[] = []
  for (const part of component.getAllSubcomponents()) {
    if (part.name !== 'standard' && part.name !== 'daylight') continue
    const observance = readObservance(part)
    if (observance) observances.push(observance)
  }
  const zone = observances.length ? buildRules(tzid, observances) : null
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(key, zone)
  return zone
}
