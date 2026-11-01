import { describe, expect, it, vi } from 'vitest'
import {
  bookResources,
  calendarPathOf,
  describeBooked,
  describeFailures,
  type BookingFlowDeps,
} from '../app/utils/resources/booking-flow'
import { describeBookingRefusal } from '../app/utils/resources/errors'
import {
  acceptLocal,
  ownBookings,
  pendingRequests,
  seedDemoRows,
  withOverlaps,
} from '../app/utils/resources/rows'
import { Temporal } from 'temporal-polyfill'

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:e1',
  'DTSTAMP:20261101T000000Z',
  'DTSTART:20261105T080000Z',
  'DTEND:20261105T090000Z',
  'SUMMARY:x',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

const a = { id: '5', name: 'Room 1' }
const b = { id: '6', name: 'Van' }
const slot = { startAt: '2026-11-05T08:00:00.000Z', endAt: '2026-11-05T09:00:00.000Z' }

function deps(post: BookingFlowDeps['post']) {
  const putObject = vi.fn(async () => ({}))
  const getObject = vi.fn(async () => ({ data: ICS, etag: '"e"' }))
  return {
    deps: { post, client: { getObject, putObject } } satisfies { post: unknown; client: unknown },
    putObject,
    getObject,
  }
}

describe('calendarPathOf', () => {
  it.each([
    ['a path of the built-in service', '/caldav/sub-1/work/', '/caldav/sub-1/work/'],
    ['one without the closing slash', '/caldav/sub-1/work', '/caldav/sub-1/work/'],
    [
      'an absolute URL of the app',
      'https://cal.test/caldav/sub-1/work/?x=1',
      '/caldav/sub-1/work/',
    ],
    ['a calendar of another server', 'https://dav.example.org/dav/cal/', null],
    ['nothing', '  ', null],
  ])('reads %s', (_name, href, path) => {
    expect(calendarPathOf(href)).toBe(path)
  })
})

describe('bookResources', () => {
  it('books each resource with the event uid and marks the event with the first booking', async () => {
    const post = vi.fn(async (path: string) => ({
      id: path.includes('/5/') ? 11 : 12,
      status: 'pending' as const,
    }))
    const d = deps(post)
    const result = await bookResources(d.deps, {
      resources: [a, b],
      slot,
      eventUid: 'e1',
      calendarHref: '/caldav/sub-1/work/',
      markUrl: '/c/e1.ics',
    })
    expect(post).toHaveBeenNthCalledWith(1, '/api/resources/5/bookings', {
      ...slot,
      eventCalendarPath: '/caldav/sub-1/work/',
      eventUid: 'e1',
    })
    expect(result.booked.map((item) => item.bookingId)).toEqual([11, 12])
    const written = (d.putObject.mock.calls[0] as unknown as [{ data: string; etag: string }])[0]
    expect(written.etag).toBe('"e"')
    expect(written.data).toContain('X-WEB-CALENDAR-RESOURCE:res:5')
    expect(written.data).toContain('X-WEB-CALENDAR-BOOKING:11')
    expect(written.data).toContain('X-WEB-CALENDAR-BOOKING-STATUS:pending')
  })

  it('reports a refusal per resource and still books the others', async () => {
    const post = vi.fn(async (path: string) => {
      if (path.includes('/5/')) throw { statusCode: 409, data: { data: { code: 'overlap' } } }
      return { id: 12, status: 'approved' as const }
    })
    const result = await bookResources(deps(post).deps, {
      resources: [a, b],
      slot,
      eventUid: 'e1',
      calendarHref: '/caldav/sub-1/work/',
      markUrl: null,
    })
    expect(describeFailures(result)).toEqual([
      'Room 1 could not be booked: it is already booked at that time.',
    ])
    expect(describeBooked(result)).toBe('Van booked.')
  })

  it('writes no marks without a url or when nothing was booked, and flags a failed marking', async () => {
    const none = deps(vi.fn(async () => ({ id: 1, status: 'approved' as const })))
    await bookResources(none.deps, {
      resources: [a],
      slot,
      eventUid: 'e1',
      calendarHref: '/caldav/sub-1/work/',
      markUrl: null,
    })
    expect(none.getObject).not.toHaveBeenCalled()

    const refused = deps(
      vi.fn(async () => {
        throw { statusCode: 403 }
      }),
    )
    const r = await bookResources(refused.deps, {
      resources: [a],
      slot,
      eventUid: 'e1',
      calendarHref: '/caldav/sub-1/work/',
      markUrl: '/c/e1.ics',
    })
    expect(refused.getObject).not.toHaveBeenCalled()
    expect(r.failed[0]!.reason).toBe('you may not book it')
    expect(describeBooked(r)).toBeNull()

    const broken = deps(vi.fn(async () => ({ id: 1, status: 'approved' as const })))
    broken.putObject.mockRejectedValue(new Error('412'))
    const m = await bookResources(broken.deps, {
      resources: [a],
      slot,
      eventUid: 'e1',
      calendarHref: '/caldav/sub-1/work/',
      markUrl: '/c/e1.ics',
    })
    expect(m.marksFailed).toBe(true)
    expect(m.booked).toHaveLength(1)
  })

  it('says which bookings wait for approval', async () => {
    const post = vi.fn(async (path: string) => ({
      id: 1,
      status: path.includes('/5/') ? ('pending' as const) : ('approved' as const),
    }))
    const result = await bookResources(deps(post).deps, {
      resources: [a, b],
      slot,
      eventUid: 'e1',
      calendarHref: '/caldav/sub-1/work/',
      markUrl: null,
    })
    expect(describeBooked(result)).toBe('Van booked; Room 1 requested, waiting for approval.')
  })
})

describe('describeBookingRefusal', () => {
  it('words the service codes and plain statuses', () => {
    expect(
      describeBookingRefusal({ statusCode: 409, data: { data: { code: 'daily_limit' } } }),
    ).toContain('limit')
    expect(describeBookingRefusal({ statusCode: 404 })).toContain('no longer exists')
    expect(describeBookingRefusal({ statusCode: 429 })).toContain('wait')
  })
})

describe('booking rows', () => {
  const rows = seedDemoRows(Temporal.PlainDate.from('2026-10-29'), 'Europe/Berlin')

  it('seeds two overlapping requests and one own booking', () => {
    expect(pendingRequests(rows).map((r) => r.id)).toEqual([9001, 9002])
    expect(rows[0]!.overlapIds).toEqual([9002])
    expect(ownBookings(rows, new Date('2026-10-29T00:00:00Z')).map((r) => r.id)).toEqual([9003])
  })

  it('accepting declines the overlapping pending request', () => {
    const result = acceptLocal(rows, 9001)
    expect(result.declined.map((r) => r.id)).toEqual([9002])
    expect(result.rows.find((r) => r.id === 9001)!.status).toBe('approved')
    expect(result.rows.find((r) => r.id === 9002)!.status).toBe('declined')
    expect(withOverlaps(result.rows).every((r) => r.overlapIds.length === 0)).toBe(true)
  })
})
