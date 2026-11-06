import { describe, expect, it } from 'vitest'
import { busyPeriods, freeBusyEvents } from '../app/utils/ical/free-busy'
import { failureOf, linkEvents } from '../app/utils/links/page'

const range = { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-11-02T00:00:00Z') }
const context = { displayTimeZone: 'Europe/Berlin', orgTimeZone: 'Europe/Berlin', range }

const object = (uid: string, summary: string, extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    'DTSTART:20261029T090000Z',
    'DTEND:20261029T100000Z',
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

const freeBusy = (...lines: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Radicale//NONSGML Radicale Server//EN',
    'BEGIN:VFREEBUSY',
    'DTSTAMP:20261105T120000Z',
    'DTSTART:20261026T000000Z',
    'DTEND:20261102T000000Z',
    ...lines,
    'END:VFREEBUSY',
    'END:VCALENDAR',
  ].join('\r\n')

describe('the events of a calendar link page at "Can view"', () => {
  it('are read in the display zone, on the one calendar of the page, without an address to write to', () => {
    const [event] = linkEvents({ level: 'read', objects: [object('a', 'School run')] }, context)
    expect(event).toMatchObject({ calendarId: 'link', title: 'School run' })
    expect(event!.start).toContain('2026-10-29T10:00')
    expect(event!.href).toBeUndefined()
    expect(event!.etag).toBeUndefined()
  })

  it('show the details a read share shows, such as the description', () => {
    const [event] = linkEvents(
      { level: 'read', objects: [object('a', 'Planning', ['DESCRIPTION:The budget numbers'])] },
      context,
    )
    expect(event).toMatchObject({ title: 'Planning', description: 'The budget numbers' })
  })

  it('keep the events of different objects apart, also when one has no title', () => {
    const events = linkEvents(
      {
        level: 'read',
        objects: [object('a', 'School run'), object('b', 'x').replace('SUMMARY:x\r\n', '')],
      },
      context,
    )
    expect(events).toHaveLength(2)
    expect(new Set(events.map((event) => event.id)).size).toBe(2)
  })

  it('expand a series the server sends as stored, in the range', () => {
    const events = linkEvents(
      {
        level: 'read',
        objects: [object('s', 'Training', ['RRULE:FREQ=DAILY;COUNT=10'])],
      },
      context,
    )
    // 29 Oct to 1 Nov: the range ends on 2 Nov
    expect(events.map((event) => event.start.slice(0, 10))).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
    expect(new Set(events.map((event) => event.id)).size).toBe(4)
  })

  it('leave out what cannot be read and list an event once', () => {
    const events = linkEvents(
      { level: 'read', objects: ['garbage', object('c', 'Once'), object('c', 'Once')] },
      context,
    )
    expect(events.map((event) => event.title)).toEqual(['Once'])
  })
})

describe('the events of a calendar link page at "Busy times only"', () => {
  it('are "Busy" blocks without a title, in the display zone', () => {
    const events = linkEvents(
      {
        level: 'free_busy',
        freeBusy: freeBusy('FREEBUSY;FBTYPE=BUSY:20261029T090000Z/20261029T100000Z'),
      },
      context,
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      calendarId: 'link',
      title: '',
      isBlocked: true,
      allDay: false,
      start: '2026-10-29T10:00:00',
      end: '2026-10-29T11:00:00',
    })
  })
})

describe('the busy times of a VFREEBUSY', () => {
  it('reads periods with an end or a duration, several on one line and folded lines', () => {
    const periods = busyPeriods(
      freeBusy(
        'FREEBUSY;FBTYPE=BUSY:20261030T090000Z/PT30M,20261028T090000Z/20261028T100000Z',
        'FREEBUSY:20261027T080000Z/2026102',
        ' 7T083000Z',
      ),
    )
    expect(periods.map((period) => [period.start.toString(), period.end.toString()])).toEqual([
      ['2026-10-27T08:00:00Z', '2026-10-27T08:30:00Z'],
      ['2026-10-28T09:00:00Z', '2026-10-28T10:00:00Z'],
      ['2026-10-30T09:00:00Z', '2026-10-30T09:30:00Z'],
    ])
  })

  it('marks tentative times, leaves out free times and what cannot be read', () => {
    const periods = busyPeriods(
      freeBusy(
        'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20261029T090000Z/20261029T100000Z',
        'FREEBUSY;FBTYPE=FREE:20261029T110000Z/20261029T120000Z',
        'FREEBUSY:20261029T130000/20261029T140000Z',
        'FREEBUSY:20261029T150000Z/20261029T140000Z',
        'FREEBUSY:nonsense',
        'SUMMARY:FREEBUSY:20261029T150000Z/20261029T160000Z',
      ),
    )
    expect(periods).toHaveLength(1)
    expect(periods[0]!.tentative).toBe(true)
  })

  it('gives every block its own id, also two at the same start', () => {
    const events = freeBusyEvents(
      freeBusy('FREEBUSY:20261029T090000Z/20261029T100000Z,20261029T090000Z/PT2H'),
      { calendarId: 'cal', displayTimeZone: 'UTC' },
    )
    expect(events.map((event) => event.status)).toEqual(['confirmed', 'confirmed'])
    expect(new Set(events.map((event) => event.id)).size).toBe(2)
  })
})

describe('why a link page cannot show its calendar', () => {
  it('tells the wrong password, an ended session, a gone link and too many tries apart', () => {
    expect(failureOf({ statusCode: 401, data: { data: { code: 'wrong_password' } } })).toBe(
      'wrong_password',
    )
    expect(failureOf({ statusCode: 401, data: { data: { code: 'session' } } })).toBe('session')
    expect(failureOf({ statusCode: 404 })).toBe('unavailable')
    expect(failureOf({ statusCode: 429 })).toBe('too_many')
    expect(failureOf(new TypeError('network'))).toBe('other')
  })
})
