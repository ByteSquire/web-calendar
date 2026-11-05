import { describe, expect, it } from 'vitest'
import { failureOf, linkEvents } from '../app/utils/links/page'

const range = { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-11-02T00:00:00Z') }
const context = { displayTimeZone: 'Europe/Berlin', orgTimeZone: 'Europe/Berlin', range }

const object = (uid: string, summary: string) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    'DTSTART:20261029T090000Z',
    'DTEND:20261029T100000Z',
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

describe('the events of a calendar link page', () => {
  it('are read in the display zone, on the one calendar of the page, without an address to write to', () => {
    const [event] = linkEvents([{ data: object('a', 'School run'), blocked: false }], context)
    expect(event).toMatchObject({ calendarId: 'link', title: 'School run' })
    expect(event!.start).toContain('2026-10-29T10:00')
    expect(event!.href).toBeUndefined()
    expect(event!.etag).toBeUndefined()
  })

  it('show what the server marked private as busy, without a title', () => {
    const [event] = linkEvents([{ data: object('b', 'Should not show'), blocked: true }], context)
    expect(event).toMatchObject({ isBlocked: true, title: '' })
  })

  it('keep the events of different objects apart, also when one has no title', () => {
    const events = linkEvents(
      [
        { data: object('a', 'School run'), blocked: false },
        { data: object('b', 'Doctor').replace('SUMMARY:Doctor\r\n', ''), blocked: true },
      ],
      context,
    )
    expect(events.map((event) => [event.title, event.isBlocked ?? false])).toEqual([
      ['School run', false],
      ['', true],
    ])
    expect(new Set(events.map((event) => event.id)).size).toBe(2)
  })

  it('leave out what cannot be read and list an event once', () => {
    const events = linkEvents(
      [
        { data: 'garbage', blocked: false },
        { data: object('c', 'Once'), blocked: false },
        { data: object('c', 'Once'), blocked: false },
      ],
      context,
    )
    expect(events.map((event) => event.title)).toEqual(['Once'])
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
