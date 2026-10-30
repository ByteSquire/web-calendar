import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { LOAD_PADDING_DAYS, loadRange, rangeKey } from '../app/utils/live/range'
import { visibleRangeFor } from '../app/utils/calendar-state'

const date = (value: string) => Temporal.PlainDate.from(value)
const range = (start: string, end: string) => ({ start: date(start), end: date(end) })
const iso = (value: { start: Date; end: Date }): [string, string] => [
  value.start.toISOString(),
  value.end.toISOString(),
]

describe('loadRange', () => {
  it('widens the visible dates by a week on both sides', () => {
    expect(LOAD_PADDING_DAYS).toBe(7)
    // Week of Monday 2026-07-06 in Berlin (UTC+2): 2026-06-29 00:00 .. 2026-07-20 00:00 local.
    expect(iso(loadRange(range('2026-07-06', '2026-07-13'), 'Europe/Berlin'))).toEqual([
      '2026-06-28T22:00:00.000Z',
      '2026-07-19T22:00:00.000Z',
    ])
  })

  it('starts each date at local midnight of the display zone, not of UTC or the organization', () => {
    const visible = range('2026-07-06', '2026-07-07')
    expect(iso(loadRange(visible, 'UTC', 0))).toEqual([
      '2026-07-06T00:00:00.000Z',
      '2026-07-07T00:00:00.000Z',
    ])
    expect(iso(loadRange(visible, 'America/Los_Angeles', 0))).toEqual([
      '2026-07-06T07:00:00.000Z',
      '2026-07-07T07:00:00.000Z',
    ])
    expect(iso(loadRange(visible, 'Asia/Kolkata', 0))).toEqual([
      '2026-07-05T18:30:00.000Z',
      '2026-07-06T18:30:00.000Z',
    ])
  })

  it('measures a 25-hour day correctly when Berlin leaves daylight saving (2026-10-25)', () => {
    const [start, end] = iso(loadRange(range('2026-10-25', '2026-10-26'), 'Europe/Berlin', 0))
    expect(start).toBe('2026-10-24T22:00:00.000Z') // +02:00
    expect(end).toBe('2026-10-25T23:00:00.000Z') // +01:00
    const hours = (Date.parse(end) - Date.parse(start)) / 3_600_000
    expect(hours).toBe(25)
  })

  it('uses the offsets on both sides of a change when the padded range spans it', () => {
    // Week 2026-10-26: padded to 2026-10-19 .. 2026-11-09, across the change of 2026-10-25? No:
    // the change is before the week, so only the padded start is still on summer time.
    expect(iso(loadRange(range('2026-10-26', '2026-11-02'), 'Europe/Berlin'))).toEqual([
      '2026-10-18T22:00:00.000Z', // 2026-10-19 00:00 at +02:00
      '2026-11-08T23:00:00.000Z', // 2026-11-09 00:00 at +01:00
    ])
  })

  it('measures a 23-hour day when Berlin enters daylight saving (2026-03-29)', () => {
    const [start, end] = iso(loadRange(range('2026-03-29', '2026-03-30'), 'Europe/Berlin', 0))
    expect(start).toBe('2026-03-28T23:00:00.000Z')
    expect(end).toBe('2026-03-29T22:00:00.000Z')
    expect((Date.parse(end) - Date.parse(start)) / 3_600_000).toBe(23)
  })

  it('works for a Sydney display zone (daylight saving starts on 2026-10-04)', () => {
    // Before the change AEST is UTC+10, after it AEDT is UTC+11.
    expect(iso(loadRange(range('2026-09-28', '2026-10-05'), 'Australia/Sydney', 0))).toEqual([
      '2026-09-27T14:00:00.000Z',
      '2026-10-04T13:00:00.000Z',
    ])
    const day = loadRange(range('2026-10-04', '2026-10-05'), 'Australia/Sydney', 0)
    expect((day.end.getTime() - day.start.getTime()) / 3_600_000).toBe(23)
    // A Sydney "today" is already tomorrow in Berlin: the instants differ from Berlin's.
    const berlin = loadRange(range('2026-10-04', '2026-10-05'), 'Europe/Berlin', 0)
    expect(berlin.start.getTime()).not.toBe(day.start.getTime())
  })

  it('covers the month grid: the month plus the neighbouring weeks', () => {
    const month = visibleRangeFor('month', date('2026-10-15'))
    const loaded = loadRange(month, 'Europe/Berlin')
    // The grid starts on Monday 2026-09-28 and ends on Sunday 2026-11-01.
    expect(loaded.start.getTime()).toBeLessThan(Date.parse('2026-09-27T22:00:00Z'))
    expect(loaded.end.getTime()).toBeGreaterThan(Date.parse('2026-11-01T23:00:00Z'))
  })

  it('starts a day that has no midnight (a gap in the zone) at its first instant', () => {
    // Sao Paulo skipped midnight on 2018-11-04: the day began at 01:00 local (UTC-02).
    const { start } = loadRange(range('2018-11-04', '2018-11-05'), 'America/Sao_Paulo', 0)
    expect(start.toISOString()).toBe('2018-11-04T03:00:00.000Z')
  })
})

describe('rangeKey', () => {
  it('changes with the dates and the zone only', () => {
    const a = rangeKey(range('2026-10-26', '2026-11-02'), 'Europe/Berlin')
    expect(rangeKey(range('2026-10-26', '2026-11-02'), 'Europe/Berlin')).toBe(a)
    expect(rangeKey(range('2026-11-02', '2026-11-09'), 'Europe/Berlin')).not.toBe(a)
    expect(rangeKey(range('2026-10-26', '2026-11-02'), 'Australia/Sydney')).not.toBe(a)
  })
})
