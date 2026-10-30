// @vitest-environment node
// Which calendars take new events and which events can be edited or deleted.
import { describe, expect, it } from 'vitest'
import type { Calendar, CalendarEvent } from '../shared/types/calendar'
import {
  eventTargetOf,
  eventWriteAccess,
  isWritableCalendar,
  writableCalendars,
} from '../app/utils/writes/rules'

const calendar = (overrides: Partial<Calendar> = {}): Calendar => ({
  id: 'dav:/caldav/alice/work/',
  name: 'Work',
  type: 'caldav',
  color: '#1d4ed8',
  defaultVisible: true,
  href: '/caldav/alice/work/',
  ...overrides,
})

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1',
  calendarId: 'dav:/caldav/alice/work/',
  uid: 'u1',
  title: 'Planning',
  start: '2026-11-05T09:00:00',
  end: '2026-11-05T10:00:00',
  allDay: false,
  status: 'confirmed',
  categoryIds: [],
  href: '/caldav/alice/work/u1.ics',
  ...overrides,
})

const byId = (...calendars: Calendar[]) => new Map(calendars.map((item) => [item.id, item]))

describe('writableCalendars', () => {
  it('keeps writable collections of the built-in service and nothing else', () => {
    const writable = calendar()
    const readOnly = calendar({ id: 'dav:/caldav/alice/ro/', readOnly: true })
    const subscription = calendar({ id: 'ics:4', type: 'ical', readOnly: true, href: undefined })
    const external = calendar({ id: 'ext:2:https://x.test/c/', href: 'https://x.test/c/' })
    const resource = calendar({ id: 'dav:/caldav/alice/room/', type: 'resource' })
    const noHref = calendar({ id: 'dav:/caldav/alice/nohref/', href: undefined })
    const emptyHref = calendar({ id: 'dav:/caldav/alice/empty/', href: '' })
    const all = [writable, readOnly, subscription, external, resource, noHref, emptyHref]
    expect(writableCalendars(all)).toEqual([writable])
    expect(all.filter(isWritableCalendar)).toEqual([writable])
  })

  it('is empty for the demo data', () => {
    expect(writableCalendars([calendar({ id: 'cal-personal', href: undefined })])).toEqual([])
  })
})

describe('eventWriteAccess', () => {
  const work = calendar()

  it('allows an event of a writable calendar that has a resource', () => {
    expect(eventWriteAccess(event(), byId(work))).toEqual({ allowed: true })
  })

  it.each<[string, Partial<CalendarEvent>, Calendar[], RegExp]>([
    ['hidden details', { isBlocked: true }, [calendar()], /busy/],
    ['an unknown calendar', {}, [], /not available/],
    [
      'a subscription',
      { calendarId: 'ics:4' },
      [calendar({ id: 'ics:4', type: 'ical', readOnly: true })],
      /subscription/,
    ],
    ['a read-only calendar', {}, [calendar({ readOnly: true })], /read-only/],
    [
      'an external account',
      { calendarId: 'ext:2:x' },
      [calendar({ id: 'ext:2:x', href: 'https://x.test/c/' })],
      /can't be changed here/,
    ],
    ['a resource calendar', {}, [calendar({ type: 'resource' })], /can't be changed here/],
    [
      'an event without a resource URL',
      { href: undefined },
      [calendar()],
      /This event can't be changed/,
    ],
  ])('refuses %s with a reason', (_name, overrides, calendars, reason) => {
    const access = eventWriteAccess(event(overrides), byId(...calendars))
    expect(access.allowed).toBe(false)
    if (!access.allowed) expect(access.reason).toMatch(reason)
  })
})

describe('eventTargetOf', () => {
  it('points to the resource and the collection', () => {
    expect(eventTargetOf(event(), byId(calendar()))).toEqual({
      href: '/caldav/alice/work/u1.ics',
      calendarHref: '/caldav/alice/work/',
      recurring: false,
    })
  })

  it('carries the series and the occurrence of a recurring event', () => {
    expect(
      eventTargetOf(
        event({ recurring: true, recurrenceId: '2026-11-05T08:00:00Z' }),
        byId(calendar()),
      ),
    ).toEqual({
      href: '/caldav/alice/work/u1.ics',
      calendarHref: '/caldav/alice/work/',
      recurring: true,
      recurrenceId: '2026-11-05T08:00:00Z',
    })
  })

  it('is null wherever access is refused', () => {
    expect(eventTargetOf(event(), byId(calendar({ readOnly: true })))).toBeNull()
    expect(eventTargetOf(event({ isBlocked: true }), byId(calendar()))).toBeNull()
  })
})
