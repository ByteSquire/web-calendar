// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatBytes, formatDate, formatDateTime, pluralize } from '../app/utils/settings/format'

describe('formatDateTime', () => {
  it.each([
    // [instant, zone, text]
    ['2026-10-29T09:00:00.000Z', 'Europe/Berlin', 'Thu, 29 Oct 2026, 10:00'],
    ['2026-10-29T09:00:00.000Z', 'UTC', 'Thu, 29 Oct 2026, 09:00'],
    // Berlin is on winter time from 25 Oct 2026 and Sydney on summer time (AEDT, UTC+11).
    ['2026-10-29T23:30:00.000Z', 'Australia/Sydney', 'Fri, 30 Oct 2026, 10:30'],
    // 24-hour clock: midnight is 00:00, never 12:00 AM or 24:00
    ['2026-12-31T23:00:00Z', 'Europe/Berlin', 'Fri, 1 Jan 2027, 00:00'],
    ['2026-03-29T01:30:00Z', 'Europe/Berlin', 'Sun, 29 Mar 2026, 03:30'],
    // the stored form of SQLite's strftime has fractions; seconds are dropped
    ['2026-07-01T12:34:56.789Z', 'Europe/Berlin', 'Wed, 1 Jul 2026, 14:34'],
  ])('%s in %s is %s', (iso, zone, expected) => {
    expect(formatDateTime(iso, zone)).toBe(expected)
  })

  it('returns text that is not a date as it is', () => {
    expect(formatDateTime('yesterday', 'Europe/Berlin')).toBe('yesterday')
    expect(formatDateTime('', 'Europe/Berlin')).toBe('')
  })

  it('does not throw for an unknown zone', () => {
    expect(formatDateTime('2026-10-29T09:00:00Z', 'Mars/Olympus')).toBe('2026-10-29T09:00:00Z')
  })
})

describe('formatDate', () => {
  it('shows the date in the zone, so the day can differ from the UTC date', () => {
    expect(formatDate('2027-10-29T23:30:00Z', 'Europe/Berlin')).toBe('Sat, 30 Oct 2027')
    expect(formatDate('2027-10-29T23:30:00Z', 'UTC')).toBe('Fri, 29 Oct 2027')
    expect(formatDate('soon', 'UTC')).toBe('soon')
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [512, '512 bytes'],
    [1023, '1023 bytes'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [12 * 1024 + 300, '12 KB'],
    [1024 * 1024, '1 MB'],
    [Math.round(2.34 * 1024 * 1024), '2.3 MB'],
  ])('%d is %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('pluralize', () => {
  it('uses the singular for one only', () => {
    expect(pluralize(0, 'event')).toBe('0 events')
    expect(pluralize(1, 'event')).toBe('1 event')
    expect(pluralize(2, 'event')).toBe('2 events')
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries')
  })
})
