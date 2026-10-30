// Recurrence rules on top of ical.js, made safe for untrusted calendars (FR-28).
//
// ical.js evaluates a rule in the wall-clock fields of DTSTART, which is what RFC 5545 asks for
// (the rule runs in DTSTART's own zone and follows that zone's daylight saving). Three things need
// care around it:
// - A rule that never matches (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`, `BYMONTHDAY=0`,
//   `INTERVAL=0`) makes `RecurIterator.next()` loop forever, which would freeze the browser tab
//   when a subscription feed carries one. Rules are checked first and the iterator counts its steps.
// - An endless rule whose DTSTART is years back would be walked one occurrence at a time. For
//   rules where it is exact, DTSTART is moved forward by whole periods first.
// - UNTIL is compared by ical.js as plain fields, so it is converted to DTSTART's zone by the caller.
import ICAL from 'ical.js'
import { DAY_MS, wallFromFields } from './zone'

/** The rule is invalid, cannot match, or took more work than allowed. */
export class RecurrenceError extends Error {}

/** Most loop turns while looking for one occurrence. A real rule needs well under 20 000. */
const MAX_SCAN_STEPS = 100_000
/** Most loop turns for one rule. */
const MAX_TOTAL_STEPS = 2_000_000

/**
 * `RecurIterator` with a work limit. The loops that can spin forever call one of the
 * `next_<frequency>` methods on every turn, so counting those is enough.
 */
class GuardedIterator extends ICAL.RecurIterator {
  // `declare`: the base constructor already runs `init()`, which calls `next_year()`.
  declare scanSteps?: number
  declare totalSteps?: number

  private tick(): void {
    this.scanSteps = (this.scanSteps ?? 0) + 1
    this.totalSteps = (this.totalSteps ?? 0) + 1
    if (this.scanSteps > MAX_SCAN_STEPS || this.totalSteps > MAX_TOTAL_STEPS) {
      throw new RecurrenceError('the rule needs too much work to evaluate')
    }
  }

  // The typings say `Time`; at the end of the rule the method returns null.
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

/** Days in each month, February counted with its leap day. */
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const BY_RANGES: { part: string; min: number; max: number; zero: boolean }[] = [
  { part: 'BYSECOND', min: 0, max: 60, zero: true },
  { part: 'BYMINUTE', min: 0, max: 59, zero: true },
  { part: 'BYHOUR', min: 0, max: 23, zero: true },
  { part: 'BYMONTH', min: 1, max: 12, zero: false },
  { part: 'BYMONTHDAY', min: -31, max: 31, zero: false },
  { part: 'BYYEARDAY', min: -366, max: 366, zero: false },
  { part: 'BYWEEKNO', min: -53, max: 53, zero: false },
  { part: 'BYSETPOS', min: -366, max: 366, zero: false },
]

const BYDAY = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/

/**
 * Why a rule cannot be evaluated, or null when it can. Covers what makes ical.js loop without end
 * or throw; the rest of RFC 5545's rule grammar is left to ical.js.
 */
export function ruleProblem(rule: ICAL.Recur): string | null {
  if (!Number.isInteger(rule.interval) || rule.interval < 1) return 'INTERVAL must be 1 or more'
  if (rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1)) {
    return 'COUNT must be 1 or more'
  }
  for (const { part, min, max, zero } of BY_RANGES) {
    for (const value of rule.getComponent(part)) {
      const number = Number(value)
      if (!Number.isInteger(number) || number < min || number > max || (number === 0 && !zero)) {
        return `${part} has the invalid value ${String(value)}`
      }
    }
  }
  const freq = rule.freq
  if (freq !== 'YEARLY') {
    if (rule.getComponent('BYYEARDAY').length) return 'BYYEARDAY needs FREQ=YEARLY'
    if (rule.getComponent('BYWEEKNO').length) return 'BYWEEKNO needs FREQ=YEARLY'
  }
  if (freq === 'WEEKLY' && rule.getComponent('BYMONTHDAY').length) {
    return 'BYMONTHDAY does not fit FREQ=WEEKLY'
  }
  for (const value of rule.getComponent('BYDAY')) {
    const match = BYDAY.exec(String(value))
    if (!match) return `BYDAY has the invalid value ${String(value)}`
    if (match[1] !== undefined && freq !== 'MONTHLY' && freq !== 'YEARLY') {
      return 'BYDAY with a number needs FREQ=MONTHLY or FREQ=YEARLY'
    }
  }
  const months = rule.getComponent('BYMONTH').map(Number)
  const days = rule.getComponent('BYMONTHDAY').map(Number)
  if (months.length && days.length) {
    // For example the 30th of February: no day ever matches and ical.js would search for good.
    const possible = months.some((month) =>
      days.some((day) => Math.abs(day) <= (MAX_DAYS_IN_MONTH[month - 1] ?? 0)),
    )
    if (!possible) return 'BYMONTH and BYMONTHDAY never match'
  }
  return null
}

function timeFromWall(wall: number, isDate: boolean): ICAL.Time {
  const date = new Date(wall)
  return ICAL.Time.fromData({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: isDate ? 0 : date.getUTCHours(),
    minute: isDate ? 0 : date.getUTCMinutes(),
    second: isDate ? 0 : date.getUTCSeconds(),
    isDate,
  })
}

const FIXED_PERIODS: Record<string, number> = {
  SECONDLY: 1000,
  MINUTELY: 60_000,
  HOURLY: 3_600_000,
  DAILY: DAY_MS,
  WEEKLY: 7 * DAY_MS,
}

/**
 * A start before `fromWall` that gives the same occurrences from there on, so an endless rule that
 * began years ago is not walked from its beginning. Only for rules without COUNT (a count runs from
 * the real start). Fixed-length periods move by whole periods; for months and years the move is a
 * whole number of years, a multiple of INTERVAL, which keeps month, day and the pattern of the
 * rule. A leap-day start stays where it is because not every year has it.
 */
function fastForward(rule: ICAL.Recur, startWall: number, fromWall: number): number {
  if (rule.count !== null || fromWall <= startWall) return startWall
  const period = FIXED_PERIODS[rule.freq]
  if (period !== undefined) {
    const steps = Math.floor((fromWall - startWall) / (period * rule.interval))
    return steps > 0 ? startWall + steps * period * rule.interval : startWall
  }
  const start = new Date(startWall)
  if (start.getUTCMonth() === 1 && start.getUTCDate() === 29) return startWall
  const yearsBack = new Date(fromWall).getUTCFullYear() - start.getUTCFullYear() - 1
  const years = Math.floor(yearsBack / rule.interval) * rule.interval
  if (years <= 0) return startWall
  start.setUTCFullYear(start.getUTCFullYear() + years)
  return start.getTime()
}

export interface RuleRun {
  rule: ICAL.Recur
  /** DTSTART as a wall time in its own zone. */
  startWall: number
  /** DTSTART is a DATE (all-day series). */
  isDate: boolean
  /** The last wall time the rule may produce, in the zone of `startWall`; null for none. */
  untilWall: number | null
  /** Occurrences before this wall time are not needed; some may still be produced. */
  fromWall: number
}

/**
 * The occurrences of one rule as wall times in DTSTART's zone, ascending. Throws RecurrenceError
 * for a rule that cannot be evaluated; the caller breaks off when it has seen enough. DTSTART
 * itself is not added when it does not fit the rule.
 */
export function* ruleWalls(run: RuleRun): Generator<number> {
  const { rule, startWall, isDate, untilWall, fromWall } = run
  const problem = ruleProblem(rule)
  if (problem) throw new RecurrenceError(problem)
  rule.until = untilWall === null ? null : timeFromWall(untilWall, isDate)
  let iterator: GuardedIterator
  try {
    const dtstart = timeFromWall(fastForward(rule, startWall, fromWall), isDate)
    iterator = new GuardedIterator({ rule, dtstart })
  } catch (error) {
    throw error instanceof RecurrenceError ? error : new RecurrenceError(messageOf(error))
  }
  for (;;) {
    let time: ICAL.Time | null
    try {
      time = iterator.next()
    } catch (error) {
      throw error instanceof RecurrenceError ? error : new RecurrenceError(messageOf(error))
    }
    if (!time) return
    const wall = wallFromFields(
      time.year,
      time.month,
      time.day,
      time.hour,
      time.minute,
      time.second,
    )
    if (wall === null) return
    yield wall
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
