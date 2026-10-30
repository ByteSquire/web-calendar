import { describe, expect, it } from 'vitest'
import { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } from '../shared/utils/time-zone'

describe('isValidTimeZone', () => {
  it('knows IANA names', () => {
    for (const zone of ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'UTC']) {
      expect(isValidTimeZone(zone)).toBe(true)
    }
  })

  it('rejects other values', () => {
    for (const zone of ['', 'Berlin', 'Mars/Olympus', 'CEST+2', ':/etc/localtime']) {
      expect(isValidTimeZone(zone)).toBe(false)
    }
  })
})

describe('resolveTimeZone', () => {
  it('uses the configured zone, trimmed', () => {
    expect(resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(resolveTimeZone('  UTC ')).toBe('UTC')
  })

  it('falls back to Europe/Berlin when the value is missing or not a zone', () => {
    expect(DEFAULT_TIME_ZONE).toBe('Europe/Berlin')
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE)
    expect(resolveTimeZone('')).toBe(DEFAULT_TIME_ZONE)
    expect(resolveTimeZone('Mars/Olympus')).toBe(DEFAULT_TIME_ZONE)
  })
})

describe('resolveDisplayTimeZone', () => {
  it("is the viewer's own zone", () => {
    expect(resolveDisplayTimeZone('Australia/Sydney', 'Europe/Berlin')).toBe('Australia/Sydney')
    expect(resolveDisplayTimeZone(' UTC ', 'Europe/Berlin')).toBe('UTC')
  })

  it('falls back to the organization zone when the browser reports none or nonsense', () => {
    expect(resolveDisplayTimeZone(undefined, 'Europe/Berlin')).toBe('Europe/Berlin')
    expect(resolveDisplayTimeZone('', 'Europe/Berlin')).toBe('Europe/Berlin')
    expect(resolveDisplayTimeZone('Mars/Olympus', 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })
})

describe('convertWallClock', () => {
  const berlin = 'Europe/Berlin'

  it('moves a time between zones, across the date line of the day', () => {
    // Berlin is UTC+1 on 28 Oct 2026 (CET), Sydney UTC+11 (AEDT).
    expect(convertWallClock('2026-10-28T17:00:00', berlin, 'Australia/Sydney')).toBe(
      '2026-10-29T03:00:00',
    )
    expect(convertWallClock('2026-10-29T03:00:00', 'Australia/Sydney', berlin)).toBe(
      '2026-10-28T17:00:00',
    )
    // Behind Berlin: Los Angeles is UTC-7 (PDT) until 1 Nov.
    expect(convertWallClock('2026-10-28T02:00:00', berlin, 'America/Los_Angeles')).toBe(
      '2026-10-27T18:00:00',
    )
  })

  it('handles half-hour and 45-minute offsets', () => {
    expect(convertWallClock('2026-10-28T10:00:00', berlin, 'Asia/Kolkata')).toBe(
      '2026-10-28T14:30:00',
    )
    expect(convertWallClock('2026-10-28T10:00:00', berlin, 'Asia/Kathmandu')).toBe(
      '2026-10-28T14:45:00',
    )
  })

  it('accepts a time without seconds and returns seconds', () => {
    expect(convertWallClock('2026-10-28T09:00', berlin, 'UTC')).toBe('2026-10-28T08:00:00')
  })

  it('returns the value unchanged in the same zone', () => {
    expect(convertWallClock('2026-10-28T09:00', berlin, berlin)).toBe('2026-10-28T09:00')
  })

  it('reads the repeated hour when clocks go back as its first occurrence', () => {
    // 02:30 on 25 Oct 2026 happens twice in Berlin; the first one is CEST (UTC+2).
    expect(convertWallClock('2026-10-25T02:30:00', berlin, 'UTC')).toBe('2026-10-25T00:30:00')
  })

  it('reads a time that does not exist when clocks go forward with the offset before the gap', () => {
    // 02:30 on 29 Mar 2026 does not exist in Berlin; RFC 5545 reads it as CET (UTC+1).
    expect(convertWallClock('2026-03-29T02:30:00', berlin, 'UTC')).toBe('2026-03-29T01:30:00')
  })
})

describe('convertEventTimes', () => {
  const timed = { start: '2026-10-28T17:00:00', end: '2026-10-28T18:00:00', allDay: false }
  const allDay = { start: '2026-10-31', end: '2026-11-02', allDay: true }

  it('moves start and end of a timed event', () => {
    expect(convertEventTimes(timed, 'Europe/Berlin', 'Australia/Sydney')).toEqual({
      start: '2026-10-29T03:00:00',
      end: '2026-10-29T04:00:00',
      allDay: false,
    })
  })

  it('leaves all-day events on their dates in every zone', () => {
    for (const zone of ['Australia/Sydney', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      expect(convertEventTimes(allDay, 'Europe/Berlin', zone)).toEqual(allDay)
    }
  })

  it('keeps other fields', () => {
    const event = { ...timed, id: 'x', title: 'Standup' }
    expect(convertEventTimes(event, 'Europe/Berlin', 'UTC')).toMatchObject({
      id: 'x',
      title: 'Standup',
    })
  })
})
