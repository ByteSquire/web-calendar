import { describe, expect, it } from 'vitest'
import type { CalendarEvent, Category } from '../shared/types/calendar'
import { DavError } from '../app/utils/caldav/errors'
import type { DavObject } from '../app/utils/caldav/types'
import {
  AUTO_CATEGORY_PREFIX,
  autoCategoryId,
  mapCategoryIds,
  reconcileCategories,
  toCategories,
  withCategoryIds,
} from '../app/utils/live/categories'
import {
  dedupeEvents,
  readCalendarEvents,
  type CalendarOutcome,
  type ReadContext,
} from '../app/utils/live/events'
import { colorForName } from '../app/utils/live/palette'
import { toFilters, toViews } from '../app/utils/live/views'
import { calendar, fixture, lines, vevent, WIDE_RANGE } from './ical-read-helpers'

const context: ReadContext = {
  displayTimeZone: 'Europe/Berlin',
  orgTimeZone: 'Europe/Berlin',
  range: WIDE_RANGE,
}
const CAL = 'dav:/caldav/u/c/'

function object(url: string, data: string, etag = '"e1"'): DavObject {
  return { url, etag, data }
}

const meeting = (uid: string, extra: string[] = []) =>
  calendar(
    vevent(
      [
        `UID:${uid}`,
        'SUMMARY:Meeting',
        'DTSTART:20261105T100000Z',
        'DTEND:20261105T110000Z',
        ...extra,
      ],
      uid,
    ),
  )

const dav = (objects: DavObject[]): CalendarOutcome => ({
  kind: 'caldav',
  calendarId: CAL,
  objects,
})

describe('readCalendarEvents: CalDAV objects', () => {
  it('reads every object of the calendar and keeps href and ETag', () => {
    const result = readCalendarEvents(
      dav([
        object('/caldav/u/c/one.ics', meeting('one'), '"a"'),
        object('/caldav/u/c/two.ics', meeting('two'), '"b"'),
      ]),
      context,
    )
    expect(result.error).toBeNull()
    expect(result.aborted).toBe(false)
    expect(result.events.map((e) => [e.uid, e.href, e.etag, e.calendarId])).toEqual([
      ['one', '/caldav/u/c/one.ics', '"a"', CAL],
      ['two', '/caldav/u/c/two.ics', '"b"', CAL],
    ])
    expect(result.events.every((e) => e.categoryIds.length === 0)).toBe(true)
  })

  it('treats the server’s expansion as final: every VEVENT is one occurrence, none is added', () => {
    const result = readCalendarEvents(
      dav([object('/caldav/u/c/a.ics', fixture('server-expanded-a-weekly.ics'))]),
      { ...context, displayTimeZone: 'UTC' },
    )
    const raw = fixture('server-expanded-a-weekly.ics').match(/BEGIN:VEVENT/g)!.length
    expect(result.events).toHaveLength(raw)
    expect(new Set(result.events.map((e) => e.id)).size).toBe(raw)
  })

  it('keeps the same instance of a series separate from another series in the same object', () => {
    const result = readCalendarEvents(
      dav([object('/caldav/u/c/a.ics', fixture('server-expanded-a-weekly.ics'))]),
      { ...context, displayTimeZone: 'UTC' },
    )
    expect(lines(result.events)[0]).toContain('A weekly')
    expect(result.events.every((e) => e.recurring === true)).toBe(true)
  })

  it('omits an empty ETag instead of passing it on', () => {
    const [event] = readCalendarEvents(
      dav([object('/caldav/u/c/one.ics', meeting('one'), '')]),
      context,
    ).events
    expect(event!.etag).toBeUndefined()
  })

  it('counts unreadable entries and warnings without failing the calendar', () => {
    const result = readCalendarEvents(
      dav([
        object('/caldav/u/c/mixed.ics', fixture('mixed-good-bad.ics')),
        object('/caldav/u/c/garbage.ics', fixture('garbage.ics')),
        object('/caldav/u/c/ok.ics', meeting('ok')),
      ]),
      context,
    )
    expect(result.error).toBeNull()
    expect(result.events.map((e) => e.uid)).toEqual(expect.arrayContaining(['good-1', 'ok']))
    expect(result.skipped).toBeGreaterThanOrEqual(3)
  })

  it('counts a warning (read anyway) apart from a skipped entry', () => {
    const unknownZone = calendar(
      vevent([
        'SUMMARY:Odd zone',
        'DTSTART;TZID=Not/AZone:20261105T100000',
        'DTEND;TZID=Not/AZone:20261105T110000',
      ]),
    )
    const result = readCalendarEvents(dav([object('/caldav/u/c/z.ics', unknownZone)]), context)
    expect(result.events).toHaveLength(1)
    expect(result.warnings).toBeGreaterThanOrEqual(1)
    expect(result.skipped).toBe(0)
    expect(result.error).toBeNull()
  })

  it('removes a second delivery of the same occurrence', () => {
    const same = object('/caldav/u/c/one.ics', meeting('one'))
    const result = readCalendarEvents(dav([same, same]), context)
    expect(result.events).toHaveLength(1)
  })
})

describe('readCalendarEvents: subscriptions', () => {
  const feed = (text: string): CalendarOutcome => ({ kind: 'ical', calendarId: 'ics:3', text })

  it('expands recurrences itself and leaves out href and ETag (nothing to write back to)', () => {
    const result = readCalendarEvents(feed(fixture('feed.ics')), {
      ...context,
      range: { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-12-31T00:00:00Z') },
    })
    expect(result.error).toBeNull()
    expect(result.events.map((e) => e.title)).toEqual(
      expect.arrayContaining(['Reformation Day', 'All Saints', 'Yearly feast']),
    )
    for (const event of result.events) {
      expect(event.calendarId).toBe('ics:3')
      expect('href' in event).toBe(false)
      expect('etag' in event).toBe(false)
    }
    // The yearly all-day feast of 1 November is expanded from 2020.
    expect(result.events.find((e) => e.title === 'Yearly feast')!.start).toBe('2026-11-01')
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length)
  })

  it('reads the same feed under two calendars into events with different ids', () => {
    const a = readCalendarEvents(feed(fixture('feed.ics')), context)
    const b = readCalendarEvents(
      { kind: 'ical', calendarId: 'ics:4', text: fixture('feed.ics') },
      context,
    )
    const ids = new Set([...a.events, ...b.events].map((e) => e.id))
    expect(ids.size).toBe(a.events.length + b.events.length)
  })
})

describe('readCalendarEvents: busy times only', () => {
  it('makes "Busy" blocks of a free/busy share, only those in the range, and no problem', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VFREEBUSY',
      'FREEBUSY:20261105T090000Z/20261105T100000Z',
      'FREEBUSY:20200101T090000Z/20200101T100000Z',
      'FREEBUSY:not-a-period',
      'END:VFREEBUSY',
      'END:VCALENDAR',
    ].join('\r\n')
    const result = readCalendarEvents(
      { kind: 'free-busy', calendarId: CAL, text },
      {
        ...context,
        range: { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') },
      },
    )
    // the unreadable period is counted, like an unreadable entry
    expect(result).toMatchObject({ error: null, skipped: 1, aborted: false })
    expect(result.events).toEqual([
      expect.objectContaining({
        calendarId: CAL,
        title: '',
        isBlocked: true,
        start: '2026-11-05T10:00:00',
        end: '2026-11-05T11:00:00',
      }),
    ])
    expect(result.events[0]!.href).toBeUndefined()
  })
})

describe('readCalendarEvents: failures', () => {
  const failed = (error: unknown): CalendarOutcome => ({ kind: 'failed', calendarId: CAL, error })

  it.each([
    ['unauthorized', 'Sign-in expired'],
    ['forbidden', 'Access denied'],
    ['not-found', 'Not found'],
    ['unavailable', 'Server unavailable'],
    ['network', 'Not reachable'],
    ['bad-response', 'Unexpected answer from the server'],
    ['rejected', 'Request refused by the server'],
  ] as const)('words a DavError of kind %s as "%s"', (kind, message) => {
    const result = readCalendarEvents(failed(new DavError(kind, 'internal detail')), context)
    expect(result).toMatchObject({ error: message, aborted: false, events: [] })
  })

  it('does not report an abort as a problem', () => {
    const result = readCalendarEvents(failed(new DavError('aborted', 'x')), context)
    expect(result).toMatchObject({ aborted: true, error: null, events: [] })
  })

  it('words the proxy’s refusal of a subscription by its reason, never with the URL', () => {
    const proxy = (reason: string) =>
      readCalendarEvents(
        {
          kind: 'failed',
          calendarId: 'ics:3',
          error: { status: 502, reason, message: 'https://secret.example/feed.ics?token=1' },
        },
        context,
      ).error
    expect(proxy('unreachable')).toBe('Not reachable')
    expect(proxy('timeout')).toBe('Source took too long')
    expect(proxy('blocked')).toBe('Address not allowed')
    expect(proxy('too-large')).toBe('File too large')
    expect(proxy('not-ical')).toBe('Not a calendar file')
    expect(proxy('http-503')).toBe('The source answered with HTTP 503')
    expect(proxy('something-new')).toBe('Server unavailable')
  })

  it('words other errors without leaking their text', () => {
    const word = (error: unknown) => readCalendarEvents(failed(error), context).error
    expect(word(Object.assign(new Error('x'), { name: 'AuthRequiredError' }))).toBe(
      'Sign-in expired',
    )
    expect(word({ statusCode: 401 })).toBe('Sign-in expired')
    expect(word({ statusCode: 404 })).toBe('Not found')
    expect(word({ cause: { name: 'AuthRequiredError' } })).toBe('Sign-in expired')
    expect(word({ data: { data: { reason: 'timeout' } } })).toBe('Source took too long')
    expect(word(new TypeError('Failed to fetch https://x.example/secret'))).toBe('Not reachable')
    expect(word(new Error('boom https://x.example/secret'))).toBe('Could not be loaded')
    expect(word('a string')).toBe('Could not be loaded')
  })
})

describe('dedupeEvents', () => {
  const ev = (id: string, title: string): CalendarEvent => ({
    id,
    uid: id,
    calendarId: 'c',
    title,
    start: '2026-11-05T10:00:00',
    end: '2026-11-05T11:00:00',
    allDay: false,
    status: 'confirmed',
    categoryIds: [],
  })

  it('keeps the first of equal ids, in order', () => {
    expect(dedupeEvents([ev('a', '1'), ev('b', '2'), ev('a', '3')]).map((e) => e.title)).toEqual([
      '1',
      '2',
    ])
  })
})

describe('categories', () => {
  const cat = (id: string, name: string, color = '#112233'): Category => ({ id, name, color })
  const named = (...names: string[]) => ({ categoryNames: names })

  it('maps server categories with their colour, or one derived from the name', () => {
    expect(
      toCategories([
        { id: 4, name: 'Work', color: '#AABBCC', shared: false },
        { id: 5, name: 'Travel', color: null, shared: true },
        { id: 6, name: 'Odd', color: 'red', shared: true },
      ]),
    ).toEqual([
      { id: '4', name: 'Work', color: '#aabbcc' },
      // a shared one says so: only admins change it
      { id: '5', name: 'Travel', color: colorForName('Travel'), shared: true },
      { id: '6', name: 'Odd', color: colorForName('Odd'), shared: true },
    ])
  })

  it('maps names to category ids ignoring case and space; unknown names become auto ids', () => {
    const categories = [cat('4', 'Work'), cat('5', 'Travel')]
    expect(mapCategoryIds(['work', ' TRAVEL ', 'Holiday'], categories)).toEqual([
      '4',
      '5',
      'auto:holiday',
    ])
    expect(mapCategoryIds(['Work', 'WORK', 'work'], categories)).toEqual(['4'])
    expect(mapCategoryIds(['', '  '], categories)).toEqual([])
    expect(mapCategoryIds(undefined, categories)).toEqual([])
    expect(mapCategoryIds([], categories)).toEqual([])
    expect(autoCategoryId('  Holiday ')).toBe(`${AUTO_CATEGORY_PREFIX}holiday`)
  })

  it('prefers a real category over an auto one with the same name', () => {
    const categories = [cat('auto:work', 'Work'), cat('4', 'work')]
    expect(mapCategoryIds(['WORK'], categories)).toEqual(['4'])
  })

  it('adds auto categories for names nobody created, with a stable palette colour', () => {
    const real = [cat('4', 'Work')]
    const next = reconcileCategories(real, [named('work', 'Holiday'), named('HOLIDAY', 'Focus')])
    expect(next.map((c) => c.id)).toEqual(['4', 'auto:holiday', 'auto:focus'])
    expect(next[1]).toEqual({
      id: 'auto:holiday',
      name: 'Holiday',
      color: colorForName('holiday'),
    })
  })

  it('returns the same list when nothing changes, so watchers stay quiet', () => {
    const real = [cat('4', 'Work')]
    const once = reconcileCategories(real, [named('Holiday')])
    expect(reconcileCategories(once, [named('holiday')])).toBe(once)
    expect(reconcileCategories(real, [named('work')])).toBe(real)
  })

  it('keeps auto categories seen earlier, so a selected one does not vanish', () => {
    const once = reconcileCategories([], [named('Holiday')])
    expect(reconcileCategories(once, []).map((c) => c.id)).toEqual(['auto:holiday'])
  })

  it('drops an auto category once a real one with that name exists', () => {
    const once = reconcileCategories([], [named('Holiday')])
    const created = [...once, cat('9', 'holiday')]
    expect(reconcileCategories(created, [named('Holiday')]).map((c) => c.id)).toEqual(['9'])
  })

  it('resolves the ids of events and leaves untouched events as they are', () => {
    const base = {
      calendarId: 'c',
      title: 't',
      start: '2026-11-05',
      end: '2026-11-06',
      allDay: true,
      status: 'confirmed' as const,
    }
    const resolved: CalendarEvent = {
      ...base,
      id: '1',
      uid: '1',
      categoryIds: ['4'],
      categoryNames: ['Work'],
    }
    const open: CalendarEvent = {
      ...base,
      id: '2',
      uid: '2',
      categoryIds: [],
      categoryNames: ['Work', 'Fun'],
    }
    const none: CalendarEvent = { ...base, id: '3', uid: '3', categoryIds: [] }
    const [a, b, c] = withCategoryIds([resolved, open, none], [cat('4', 'Work')])
    expect(a).toBe(resolved)
    expect(b!.categoryIds).toEqual(['4', 'auto:fun'])
    expect(c).toBe(none)
  })
})

describe('views and filters', () => {
  it('maps views to the state’s shape, keeping every ref', () => {
    expect(
      toViews([
        {
          id: 12,
          name: 'Team',
          icon: 'users',
          calendars: [
            { ref: 'dav:/caldav/u/a/', color: '#112233' },
            { ref: 'ics:3', color: null },
          ],
          isAdmin: false,
          ownerId: 7,
        },
        { id: 13, name: 'All', icon: 'rocket', calendars: [], isAdmin: true, ownerId: null },
      ]),
    ).toEqual([
      {
        id: '12',
        name: 'Team',
        icon: 'users',
        calendarIds: ['dav:/caldav/u/a/', 'ics:3'],
        isAdmin: false,
        ownerId: '7',
      },
      // An unknown icon falls back to the calendar icon; an admin view has no owner.
      { id: '13', name: 'All', icon: 'calendar', calendarIds: [], isAdmin: true },
    ])
  })

  it('maps filters', () => {
    expect(toFilters([{ id: 3, name: 'Offsite', kind: 'text', value: 'offsite' }])).toEqual([
      { id: '3', name: 'Offsite', kind: 'text', value: 'offsite' },
    ])
  })
})
