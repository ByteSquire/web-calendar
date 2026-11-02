import { describe, expect, it } from 'vitest'
import { whenSummary } from '../app/utils/writes/when-summary'

describe('whenSummary', () => {
  it('names the day once for a timed event on one day', () => {
    expect(whenSummary({ allDay: false, start: '2026-11-06T14:00', end: '2026-11-06T15:30' })).toBe(
      'Fri 6 Nov, 14:00–15:30',
    )
  })

  it('names both days when the event spans midnight', () => {
    expect(whenSummary({ allDay: false, start: '2026-11-06T22:00', end: '2026-11-07T01:00' })).toBe(
      'Fri 6 Nov, 22:00 – Sat 7 Nov, 01:00',
    )
  })

  it('shows all-day events by day', () => {
    expect(whenSummary({ allDay: true, start: '2026-11-06', end: '2026-11-06' })).toMatch(
      /^Fri,? 6 Nov, all day$/,
    )
    expect(whenSummary({ allDay: true, start: '2026-11-06', end: '2026-11-08' })).toMatch(
      /^Fri,? 6 Nov – Sun,? 8 Nov, all day$/,
    )
  })

  it('does not shift the wall-clock time, whatever the zone of the machine', () => {
    expect(whenSummary({ allDay: false, start: '2026-03-29T02:30', end: '2026-03-29T03:30' })).toBe(
      'Sun 29 Mar, 02:30–03:30',
    )
  })

  it('falls back to the typed text while the dates are not complete', () => {
    expect(whenSummary({ allDay: false, start: '2026-11-0', end: '' })).toBe('2026-11-0')
    expect(whenSummary({ allDay: false, start: '', end: '' })).toBe('')
  })
})
