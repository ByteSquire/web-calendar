// A new event as iCalendar text (`createEventResource`, re-exported by write.ts).
import { escapeText, makeProp, serializeDocument, type Comp, type Prop } from './write-lines'
import { t } from '../i18n'
import {
  EditError,
  type NewEventInput,
  type NewEventRecurrence,
  type NewEventResource,
  type WallClockRange,
  type WriteContext,
} from './write-types'
import {
  isDateWall,
  makeTimeProp,
  normalizeWall,
  toBasic,
  toBasicUtc,
  zoneNamed,
  type TimeInfo,
} from './write-zone'
import {
  STATUS_TEXT,
  checkContext,
  parseRange,
  checkChanges,
  nowOf,
  displayInfo,
  stampOf,
  ensureTimezone,
} from './write-core'

const PRODID = '-//web-calendar//Web Calendar//EN'

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
