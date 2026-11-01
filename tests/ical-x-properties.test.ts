// @vitest-environment node
// The X-WEB-CALENDAR-* properties of a booking (design §5): kept when the app edits an event, shown
// on the parsed event of a trusted calendar, and removed from what a stranger sends.
import { describe, expect, it } from 'vitest'
import { setBookingMarks } from '../app/utils/ical/booking-marks'
import { readCalendarObject } from '../app/utils/ical/read'
import { splitCalendar } from '../app/utils/ical/split'
import { editEventResource, type WriteContext } from '../app/utils/ical/write'
import { parseBookingMarks } from '../app/utils/ical/x-properties'
import { calendar, options, vevent } from './ical-read-helpers'

const CTX: WriteContext = {
  displayTimeZone: 'Europe/Berlin',
  orgTimeZone: 'Europe/Berlin',
  now: new Date('2026-10-30T12:00:00Z'),
}

const BOOKED = vevent([
  'DTSTART:20261105T090000Z',
  'DTEND:20261105T100000Z',
  'SUMMARY:Planning',
  'X-WEB-CALENDAR-RESOURCE:res:7',
  'X-WEB-CALENDAR-BOOKING:42',
  'X-WEB-CALENDAR-BOOKING-STATUS:approved',
  'X-OTHER-CLIENT;X-P=1:keep me',
])

describe('reading', () => {
  it('exposes the booking marks of a trusted calendar', () => {
    const { events } = readCalendarObject(
      calendar(BOOKED),
      options({ trustBookingProperties: true }),
    )
    expect(events[0]?.bookingMarks).toEqual({ resourceId: 7, bookingId: 42, status: 'approved' })
  })

  it('ignores them unless the calendar is trusted', () => {
    const { events } = readCalendarObject(calendar(BOOKED), options())
    expect(events).toHaveLength(1)
    expect(events[0]?.bookingMarks).toBeUndefined()
  })

  it('leaves out marks that are not valid', () => {
    expect(parseBookingMarks('res:abc', '4', 'approved')).toBeUndefined()
    expect(parseBookingMarks('res:3', 'x', 'maybe')).toEqual({ resourceId: 3 })
    expect(parseBookingMarks(undefined, '4', 'approved')).toBeUndefined()
  })
})

describe('editing', () => {
  it('keeps the booking properties and other X- properties when the title changes', () => {
    const { updated } = editEventResource(
      calendar(BOOKED),
      { kind: 'series' },
      { title: 'Planning 2' },
      CTX,
    )
    expect(updated).toContain('X-WEB-CALENDAR-RESOURCE:res:7\r\n')
    expect(updated).toContain('X-WEB-CALENDAR-BOOKING:42\r\n')
    expect(updated).toContain('X-WEB-CALENDAR-BOOKING-STATUS:approved\r\n')
    expect(updated).toContain('X-OTHER-CLIENT;X-P=1:keep me\r\n')
    expect(updated).toContain('SUMMARY:Planning 2')
  })
})

describe('setBookingMarks', () => {
  it('adds, replaces and removes the three properties and nothing else', () => {
    const plain = calendar(vevent(['DTSTART:20261105T090000Z', 'SUMMARY:Planning']))
    const marked = setBookingMarks(plain, { resourceId: 7, bookingId: 42, status: 'pending' })
    expect(marked).toContain('X-WEB-CALENDAR-RESOURCE:res:7\r\n')
    expect(marked).toContain('X-WEB-CALENDAR-BOOKING-STATUS:pending\r\n')
    const approved = setBookingMarks(marked, { resourceId: 7, bookingId: 42, status: 'approved' })
    expect(approved.match(/X-WEB-CALENDAR-BOOKING-STATUS/g)).toHaveLength(1)
    expect(approved).toContain('X-WEB-CALENDAR-BOOKING-STATUS:approved')
    expect(setBookingMarks(approved, null)).toBe(plain)
  })
})

describe('importing', () => {
  it('removes X- properties of the event, so a stranger cannot claim a booking', async () => {
    const { resources } = await splitCalendar(calendar(BOOKED))
    const ics = resources[0]?.ics ?? ''
    expect(ics).toContain('SUMMARY:Planning')
    expect(ics).not.toContain('X-WEB-CALENDAR')
    expect(ics).not.toContain('X-OTHER-CLIENT')
  })
})
