import { describe, expect, it } from 'vitest'
import type { AvailabilityResponse } from '../shared/types/resources-api'
import {
  apiIdOfResourceCalendar,
  availabilityRanges,
  availabilityToEvents,
  BUSY_PENDING_TITLE,
  isResourceCalendarId,
  toCalendarResources,
  toResourceCalendars,
} from '../app/utils/resources/availability'
import { slotOf, wallClockOf } from '../app/utils/resources/slot'
import type { ApiResource } from '../app/utils/resources/types'

const ZONE = 'Europe/Berlin'

const room: ApiResource = {
  id: 5,
  name: 'Room 1',
  type: 'room',
  location: 'Floor 2',
  capacity: 8,
  description: null,
  active: true,
  right: 'book',
}

describe('resources as sidebar entries', () => {
  it("takes the viewer's colour of a resource, and keeps the palette's as its own", () => {
    const [plain] = toResourceCalendars([room])
    const [chosen] = toResourceCalendars([room], [{ ref: 'res:5', color: '#B91C1C' }])
    expect(chosen!.color).toBe('#b91c1c')
    expect(chosen!.ownColor).toBe(plain!.color)
    expect(toResourceCalendars([room], [{ ref: 'res:6', color: '#b91c1c' }])[0]!.color).toBe(
      plain!.color,
    )
  })

  it('builds a read-only resource calendar that starts hidden, and the resource that points at it', () => {
    const [calendar] = toResourceCalendars([room])
    expect(calendar).toMatchObject({
      id: 'res:5',
      name: 'Room 1',
      type: 'resource',
      resourceType: 'room',
      defaultVisible: false,
      readOnly: true,
    })
    expect(toCalendarResources([room, { ...room, id: 6, location: null, capacity: null }])).toEqual(
      [
        {
          id: '5',
          calendarId: 'res:5',
          name: 'Room 1',
          type: 'room',
          location: 'Floor 2',
          capacity: 8,
        },
        { id: '6', calendarId: 'res:6', name: 'Room 1', type: 'room' },
      ],
    )
  })

  it('recognises resource calendar ids', () => {
    expect(isResourceCalendarId('res:5')).toBe(true)
    expect(isResourceCalendarId('dav:/caldav/u/a/')).toBe(false)
    expect(apiIdOfResourceCalendar('res:5')).toBe(5)
    expect(apiIdOfResourceCalendar('res:x')).toBeNull()
    expect(apiIdOfResourceCalendar('dav:/res:5')).toBeNull()
  })
})

describe('availabilityRanges', () => {
  const at = (iso: string) => new Date(iso)

  it('keeps a short range in one piece', () => {
    expect(availabilityRanges(at('2026-10-19T00:00:00Z'), at('2026-11-09T00:00:00Z'))).toEqual([
      { from: '2026-10-19T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
    ])
  })

  it('cuts a long range into pieces of at most 62 days', () => {
    const pieces = availabilityRanges(at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'))
    expect(pieces).toHaveLength(6)
    for (const piece of pieces) {
      expect(Date.parse(piece.to) - Date.parse(piece.from)).toBeLessThanOrEqual(62 * 86_400_000)
    }
    expect(pieces[0]!.from).toBe('2026-01-01T00:00:00.000Z')
    expect(pieces.at(-1)!.to).toBe('2027-01-01T00:00:00.000Z')
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.from).toBe(pieces[i - 1]!.to)
  })

  it('never sends more than the cap', () => {
    expect(
      availabilityRanges(at('2020-01-01T00:00:00Z'), at('2030-01-01T00:00:00Z'), 3),
    ).toHaveLength(3)
  })
})

describe('availabilityToEvents', () => {
  const response: AvailabilityResponse = {
    from: '2026-11-01T00:00:00.000Z',
    to: '2026-11-30T00:00:00.000Z',
    resources: [
      {
        resourceId: 5,
        entries: [
          {
            bookingId: 1,
            start: '2026-11-05T08:00:00.000Z',
            end: '2026-11-05T09:00:00.000Z',
            status: 'approved',
            blocked: true,
            mine: false,
          },
          {
            bookingId: 2,
            start: '2026-11-06T08:00:00.000Z',
            end: '2026-11-06T09:00:00.000Z',
            status: 'pending',
            blocked: true,
            mine: false,
          },
          {
            bookingId: 3,
            start: '2026-11-07T08:00:00.000Z',
            end: '2026-11-07T09:00:00.000Z',
            status: 'approved',
            blocked: false,
            requesterName: 'Bob',
            eventUid: 'known',
            mine: false,
          },
          {
            bookingId: 4,
            start: '2026-11-08T08:00:00.000Z',
            end: '2026-11-08T09:00:00.000Z',
            status: 'pending',
            blocked: false,
            requesterName: 'Carol',
            eventUid: 'unknown',
            mine: true,
          },
        ],
      },
    ],
  }
  const events = availabilityToEvents(response, {
    displayTimeZone: ZONE,
    titleOf: (uid) => (uid === 'known' ? 'Design workshop' : undefined),
  })

  it('shows an approved blocked entry as the hatched Busy entry, without details', () => {
    expect(events[0]).toMatchObject({
      id: 'avail:1',
      calendarId: 'res:5',
      title: 'Busy',
      isBlocked: true,
      status: 'confirmed',
      start: '2026-11-05T09:00:00',
      end: '2026-11-05T10:00:00',
    })
    expect(events[0]).not.toHaveProperty('description')
  })

  it('shows a pending blocked entry as tentative and still without details', () => {
    expect(events[1]).toMatchObject({ title: BUSY_PENDING_TITLE, status: 'tentative' })
    expect(events[1]!.isBlocked).toBeUndefined()
  })

  it('names the requester and uses the title of an event the browser has', () => {
    expect(events[2]).toMatchObject({
      title: 'Design workshop',
      description: 'Booked by Bob',
      status: 'confirmed',
    })
    expect(events[3]).toMatchObject({ title: 'Booked by Carol', status: 'tentative' })
  })

  it('points every entry at its resource', () => {
    expect(new Set(events.map((event) => event.resourceId))).toEqual(new Set(['5']))
    expect(new Set(events.map((event) => event.id)).size).toBe(4)
  })
})

describe('slots', () => {
  it('converts display-zone wall clock to UTC instants', () => {
    expect(
      slotOf({ start: '2026-11-05T09:00', end: '2026-11-05T10:30', allDay: false }, ZONE),
    ).toEqual({ startAt: '2026-11-05T08:00:00.000Z', endAt: '2026-11-05T09:30:00.000Z' })
  })

  it('takes an all-day range from midnight to midnight (end exclusive)', () => {
    expect(slotOf({ start: '2026-07-01', end: '2026-07-02', allDay: true }, ZONE)).toEqual({
      startAt: '2026-06-30T22:00:00.000Z',
      endAt: '2026-07-01T22:00:00.000Z',
    })
  })

  it('goes back to wall clock', () => {
    expect(wallClockOf('2026-11-05T08:00:00.000Z', ZONE)).toBe('2026-11-05T09:00:00')
  })
})
