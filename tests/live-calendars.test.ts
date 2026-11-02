import { describe, expect, it } from 'vitest'
import type { Calendar } from '../shared/types/calendar'
import type { DavCalendar } from '../app/utils/caldav/types'
import type { ApiCalendarPref, ApiIcalSubscription } from '../app/utils/live/api-types'
import {
  AVAILABILITY_COLLECTION,
  buildCalendars,
  davRef,
  isAvailabilityCollection,
  reconcileVisibleCalendars,
  subscriptionIdOf,
} from '../app/utils/live/calendars'
import { colorForName, normalizeHexColor, PALETTE, paletteColor } from '../app/utils/live/palette'

describe('isAvailabilityCollection', () => {
  it('recognises the shared availability collection of a home, as a path or a URL', () => {
    expect(AVAILABILITY_COLLECTION).toBe('resource-availability')
    for (const url of [
      '/caldav/189c6a24-f9cb-437b-8f58-b5cc8d7f909e/resource-availability/',
      '/caldav/u/resource-availability',
      'https://cal.example.org/caldav/u/resource-availability/',
      ' /caldav/u/resource-availability/ ',
      '/caldav/u/resource%2Davailability/',
      '/caldav/u/resource-availability/?x=1',
    ]) {
      expect(isAvailabilityCollection(url), url).toBe(true)
    }
  })

  it('leaves every other collection alone', () => {
    for (const url of [
      '/caldav/u/def-calendar/',
      '/caldav/u/shared-12/',
      '/caldav/u/resource-availability-2/',
      '/caldav/u/my-resource-availability/',
      '/caldav/u/resource-availability/sub/',
      '/resource-availability/',
      '/caldav/resource-availability/x.ics',
      '',
    ]) {
      expect(isAvailabilityCollection(url), url).toBe(false)
    }
  })
})

function collection(path: string, extra: Partial<DavCalendar> = {}): DavCalendar {
  return {
    url: path,
    displayName: path.split('/').filter(Boolean).pop() ?? '',
    color: null,
    ctag: null,
    components: ['VEVENT'],
    readOnly: false,
    ...extra,
  }
}

function subscription(id: number, extra: Partial<ApiIcalSubscription> = {}): ApiIcalSubscription {
  return {
    id,
    ref: `ics:${id}`,
    name: `Feed ${id}`,
    url: `https://example.org/${id}.ics`,
    color: null,
    shared: false,
    ...extra,
  }
}

const pref = (ref: string, extra: Partial<ApiCalendarPref> = {}): ApiCalendarPref => ({
  ref,
  color: null,
  visible: true,
  ...extra,
})

describe('refs', () => {
  it.each([
    ['/caldav/u1/abc/', 'dav:/caldav/u1/abc/'],
    ['/caldav/u1/abc', 'dav:/caldav/u1/abc/'],
    ['http://127.0.0.1:3300/caldav/u1/abc/', 'dav:/caldav/u1/abc/'],
    [' /caldav/u1/abc/ ', 'dav:/caldav/u1/abc/'],
  ])('davRef(%s) = %s', (url, ref) => {
    expect(davRef(url)).toBe(ref)
  })

  it.each([
    ['ics:7', '7'],
    ['ics:123456789012345', '123456789012345'],
    ['ics:0', null],
    ['ics:07', null],
    ['ics:', null],
    ['ics:1234567890123456', null],
    ['ics:7/../x', null],
    ['dav:/caldav/u/c/', null],
    ['7', null],
  ])('subscriptionIdOf(%s) = %s', (ref, id) => {
    expect(subscriptionIdOf(ref)).toBe(id)
  })
})

describe('palette', () => {
  it('assigns colours by position and wraps around', () => {
    expect(paletteColor(0)).toBe(PALETTE[0])
    expect(paletteColor(PALETTE.length)).toBe(PALETTE[0])
    expect(paletteColor(PALETTE.length + 3)).toBe(PALETTE[3])
    expect(paletteColor(-1)).toBe(PALETTE[PALETTE.length - 1])
  })

  it('derives a stable colour from a name, whatever the letter case or space', () => {
    expect(colorForName('Holiday')).toBe(colorForName('  holiday '))
    expect(PALETTE).toContain(colorForName('Holiday') as (typeof PALETTE)[number])
  })

  it('accepts only #rrggbb as a colour', () => {
    expect(normalizeHexColor('#AABBCC')).toBe('#aabbcc')
    for (const bad of ['#abc', '#aabbccdd', 'red', '', null, undefined, 'javascript:1']) {
      expect(normalizeHexColor(bad)).toBeNull()
    }
  })
})

describe('buildCalendars', () => {
  it('builds CalDAV calendars first, then subscriptions, as the sources gave them', () => {
    const calendars = buildCalendars({
      collections: [collection('/caldav/u/a/'), collection('/caldav/u/b/', { readOnly: true })],
      subscriptions: [subscription(3), subscription(5, { shared: true })],
      prefs: [],
      ownerId: '9',
    })
    expect(calendars.map((c) => [c.id, c.type, c.readOnly ?? false])).toEqual([
      ['dav:/caldav/u/a/', 'caldav', false],
      ['dav:/caldav/u/b/', 'caldav', true],
      ['ics:3', 'ical', true],
      ['ics:5', 'ical', true],
    ])
    const [first, , feed] = calendars
    expect(first).toMatchObject({ href: '/caldav/u/a/', name: 'a', ownerId: '9' })
    expect(feed).toMatchObject({ sourceUrl: 'https://example.org/3.ics', name: 'Feed 3' })
    expect(feed!.ownerId).toBeUndefined()
    expect(feed!.href).toBeUndefined()
  })

  it('takes the server colour and falls back to the palette by position', () => {
    const calendars = buildCalendars({
      collections: [
        collection('/caldav/u/a/'),
        collection('/caldav/u/b/', { color: '#FF8800' }),
        collection('/caldav/u/c/'),
      ],
      subscriptions: [subscription(1)],
      prefs: [],
    })
    expect(calendars.map((c) => c.color)).toEqual([
      paletteColor(0),
      '#ff8800',
      paletteColor(2),
      paletteColor(3),
    ])
  })

  it('lets the viewer override the colour and hide a calendar; no preference means visible', () => {
    const calendars = buildCalendars({
      collections: [
        collection('/caldav/u/a/', { color: '#112233' }),
        collection('/caldav/u/b/'),
        collection('/caldav/u/c/'),
      ],
      subscriptions: [subscription(4, { color: '#445566' })],
      prefs: [
        pref('dav:/caldav/u/a/', { color: '#abcdef' }),
        pref('dav:/caldav/u/b/', { visible: false }),
        pref('ics:4', { visible: false, color: '#fedcba' }),
        pref('dav:/caldav/u/gone/', { visible: false }),
      ],
    })
    expect(calendars.map((c) => [c.color, c.defaultVisible])).toEqual([
      ['#abcdef', true],
      [paletteColor(1), false],
      [paletteColor(2), true],
      ['#fedcba', false],
    ])
  })

  it('ignores unusable colours from the preferences and the source', () => {
    const [calendar] = buildCalendars({
      collections: [collection('/caldav/u/a/', { color: 'url(javascript:1)' })],
      subscriptions: [],
      prefs: [pref('dav:/caldav/u/a/', { color: 'red' })],
    })
    expect(calendar!.color).toBe(paletteColor(0))
  })

  it('keeps one calendar per ref', () => {
    const calendars = buildCalendars({
      collections: [collection('/caldav/u/a/'), collection('http://h/caldav/u/a/')],
      subscriptions: [],
      prefs: [],
    })
    expect(calendars).toHaveLength(1)
  })

  it('is empty without sources', () => {
    expect(buildCalendars({ collections: [], subscriptions: [], prefs: [] })).toEqual([])
  })
})

describe('reconcileVisibleCalendars', () => {
  const cal = (id: string, defaultVisible: boolean): Calendar => ({
    id,
    name: id,
    type: 'caldav',
    color: '#000000',
    defaultVisible,
  })

  it('starts with the calendars visible by default', () => {
    expect(
      reconcileVisibleCalendars({
        visibleIds: [],
        previous: [],
        next: [cal('a', true), cal('b', false), cal('c', true)],
      }),
    ).toEqual(['a', 'c'])
  })

  it('keeps the viewer’s choice for known calendars, drops gone ones, adds new ones by preference', () => {
    const previous = [cal('a', true), cal('b', true), cal('gone', true)]
    expect(
      reconcileVisibleCalendars({
        visibleIds: ['b', 'gone'],
        previous,
        next: [cal('a', true), cal('b', true), cal('new1', true), cal('new2', false)],
      }),
    ).toEqual(['b', 'new1'])
  })
})
