import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { createCalendarState, type StateFactory } from '../app/utils/calendar-state'
import { DavError } from '../app/utils/caldav/errors'
import type { CalendarReader, ReadCalendar, ReadResult } from '../app/utils/caldav/reader'
import type { DavCalendar, DavObject } from '../app/utils/caldav/types'
import type {
  ApiCalendarPref,
  ApiCategory,
  ApiFilter,
  ApiIcalSubscription,
  ApiMe,
  ApiView,
} from '../app/utils/live/api-types'
import { loadRange } from '../app/utils/live/range'
import { createLiveLoader, DEFAULT_CALENDAR_NAME, type LiveDeps } from '../app/utils/live/loader'
import { emptySeed } from '../app/utils/live/seed'
import { createLiveStatusState } from '../app/utils/live/status'
import { calendar as ics, fixture, vevent } from './ical-read-helpers'

// The loader with fakes for everything outside it: the CalDAV client and reader, the API, the
// subscriptions' fetch and the timers.

const anchor = Temporal.PlainDate.from('2026-10-28') // a Wednesday; the week starts 2026-10-26
const ZONE = 'Europe/Berlin'

const A = '/caldav/u/a/'
const B = '/caldav/u/b/'

function memoryState(): StateFactory {
  const store = new Map<string, Ref<unknown>>()
  return <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key) as Ref<T>
  }
}

const collection = (url: string, displayName: string, extra: Partial<DavCalendar> = {}) =>
  ({
    url,
    displayName,
    color: null,
    ctag: null,
    components: ['VEVENT'],
    readOnly: false,
    freeBusyOnly: false,
    ...extra,
  }) satisfies DavCalendar

function object(url: string, uid: string, title: string, extra: string[] = []): DavObject {
  return {
    url,
    etag: '"e"',
    data: ics(
      vevent(
        [
          `UID:${uid}`,
          `SUMMARY:${title}`,
          'DTSTART:20261028T090000Z',
          'DTEND:20261028T100000Z',
          ...extra,
        ],
        uid,
      ),
    ),
  }
}

/** Timers that run only when the test says so, and remember the delay they were asked for. */
function manualTimers() {
  let next = 1
  const pending = new Map<number, { callback: () => void; ms: number }>()
  return {
    set: (callback: () => void, ms: number) => {
      pending.set(next, { callback, ms })
      return next++
    },
    clear: (handle: unknown) => {
      pending.delete(handle as number)
    },
    count: () => pending.size,
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire: async () => {
      const due = [...pending.values()]
      pending.clear()
      for (const entry of due) entry.callback()
      await settle()
    },
  }
}

/** Lets promise chains and Vue's scheduler run. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

interface Setup {
  me?: ApiMe
  prefs?: ApiCalendarPref[]
  categories?: ApiCategory[]
  filters?: ApiFilter[]
  views?: ApiView[]
  subscriptions?: ApiIcalSubscription[]
  collections?: DavCalendar[]
  /** Paths whose request fails. */
  failing?: Record<string, unknown>
}

function harness(setup: Setup = {}) {
  const state = memoryState()
  const store = createCalendarState(state, {
    seed: emptySeed,
    today: () => anchor,
    sidebarOpen: () => true,
  })
  const status = createLiveStatusState(state)
  const sourcesVersion = ref(0)
  // The shared state of `useUserTimeZone()`; the display zone is this one, else the browser's.
  const userZone = ref<string | null>(null)
  const timers = manualTimers()

  const data = {
    me: setup.me ?? {
      id: 7,
      sub: 'sub-7',
      username: 'alice',
      name: 'Alice',
      email: 'alice@example.org',
      isAdmin: false,
      timeZone: null,
      sidebarOrder: null,
    },
    prefs: setup.prefs ?? [],
    categories: setup.categories ?? [],
    filters: setup.filters ?? [],
    views: setup.views ?? [],
    subscriptions: setup.subscriptions ?? [],
    collections: setup.collections ?? [collection(A, 'Alpha'), collection(B, 'Beta')],
    failing: { ...setup.failing } as Record<string, unknown>,
    /** url -> what the reader returns for it */
    objects: new Map<string, DavObject[] | DavError>([
      [A, [object(`${A}one.ics`, 'one', 'Alpha meeting')]],
      [B, [object(`${B}two.ics`, 'two', 'Beta meeting')]],
    ]),
    icsText: new Map<string, string | unknown>(),
    shared: [] as {
      id: number
      name: string
      kind: 'personal' | 'shared' | 'resource'
      owner: string | null
    }[],
    /** url -> the VFREEBUSY a free/busy share gives */
    freeBusy: new Map<string, string>(),
  }

  const api = vi.fn(async (path: string): Promise<unknown> => {
    if (path in data.failing) throw data.failing[path]
    switch (path) {
      case '/api/me':
        return data.me
      case '/api/calendar-prefs':
        return { prefs: data.prefs }
      case '/api/categories':
        return { categories: data.categories }
      case '/api/filters':
        return { filters: data.filters }
      case '/api/views':
        return { views: data.views }
      case '/api/ical-subscriptions':
        return { subscriptions: data.subscriptions }
      case '/api/shared-calendars':
        return { calendars: data.shared }
      default:
        throw new Error(`unexpected request ${path}`)
    }
  })

  const listCalendars = vi.fn(async () => {
    if ('caldav' in data.failing) throw data.failing.caldav
    return data.collections.slice()
  })
  const renameCalendar = vi.fn(async (_url: string, _name: string) => {
    if ('rename' in data.failing) throw data.failing.rename
  })
  const createCalendar = vi.fn(async (args: { displayName: string }) => {
    const created = collection('/caldav/u/new/', args.displayName)
    data.collections.push(created)
    return created
  })

  const read = vi.fn(
    async (
      calendars: readonly ReadCalendar[],
      _range: { start: Date; end: Date },
      _options?: { force?: boolean },
    ): Promise<ReadResult[]> =>
      calendars.map((calendar) => {
        if (calendar.freeBusy) {
          return { calendarUrl: calendar.url, freeBusy: data.freeBusy.get(calendar.url) ?? '' }
        }
        const found = data.objects.get(calendar.url)
        return found instanceof DavError
          ? { calendarUrl: calendar.url, error: found }
          : { calendarUrl: calendar.url, objects: found ?? [] }
      }),
  )
  const fetchIcs = vi.fn(async (id: string): Promise<string> => {
    const text = data.icsText.get(id)
    if (typeof text !== 'string') throw text ?? new Error('no feed')
    return text
  })
  const notifyProblems = vi.fn()

  const deps: LiveDeps = {
    store,
    status,
    client: { listCalendars, createCalendar, renameCalendar } as unknown as LiveDeps['client'],
    reader: { read } as unknown as Pick<CalendarReader, 'read'>,
    api: api as unknown as LiveDeps['api'],
    fetchIcs,
    displayTimeZone: () => userZone.value ?? ZONE,
    orgTimeZone: () => ZONE,
    setUserTimeZone: (zone) => {
      userZone.value = zone
    },
    sourcesVersion,
    notifyProblems,
    timers,
    now: () => 1_700_000_000_000,
  }
  const loader = createLiveLoader(deps)
  return {
    store,
    status,
    data,
    api,
    listCalendars,
    createCalendar,
    renameCalendar,
    read,
    fetchIcs,
    notifyProblems,
    sourcesVersion,
    userZone,
    timers,
    loader,
    titles: () => store.events.value.map((e) => e.title).sort(),
    readUrls: () => read.mock.calls.map(([calendars]) => calendars.map((c) => c.url)),
  }
}

const idA = `dav:${A}`
const idB = `dav:${B}`

describe('first load', () => {
  it('fills the user, calendars, views, categories and filters, then the events', async () => {
    const h = harness({
      categories: [{ id: 1, name: 'Work', color: '#112233', shared: false }],
      filters: [{ id: 4, name: 'Offsite', kind: 'text', value: 'offsite' }],
      views: [
        {
          id: 9,
          name: 'Both',
          icon: 'users',
          calendars: [
            { ref: idA, color: null },
            { ref: 'ics:99', color: null },
          ],
          isAdmin: false,
          ownerId: 7,
        },
      ],
      prefs: [
        { ref: idA, color: '#abcdef', visible: true },
        { ref: idB, color: null, visible: false },
      ],
    })
    h.data.objects.set(A, [object(`${A}one.ics`, 'one', 'Alpha meeting', ['CATEGORIES:work,Fun'])])
    await h.loader.start()

    expect(h.store.currentUser.value).toMatchObject({
      id: '7',
      oidcSub: 'sub-7',
      name: 'Alice',
      email: 'alice@example.org',
    })
    expect(h.store.calendars.value.map((c) => [c.id, c.name, c.color, c.defaultVisible])).toEqual([
      [idA, 'Alpha', '#abcdef', true],
      [idB, 'Beta', expect.stringMatching(/^#/), false],
    ])
    expect(h.store.views.value.map((v) => [v.id, v.calendarIds])).toEqual([['9', [idA, 'ics:99']]])
    expect(h.store.filters.value.map((f) => f.id)).toEqual(['4'])
    // Only the calendar the preferences leave visible is read.
    expect(h.store.visibleCalendarIds.value).toEqual([idA])
    expect(h.readUrls()).toEqual([[A]])
    expect(h.titles()).toEqual(['Alpha meeting'])
    // The category names resolve to the real category and to an auto category.
    expect(h.store.categories.value.map((c) => c.id)).toEqual(['1', 'auto:fun'])
    expect(h.store.events.value[0]!.categoryIds).toEqual(['1', 'auto:fun'])
    expect(h.status.loading.value).toBe(false)
    expect(h.status.lastLoadedAt.value).toBe(1_700_000_000_000)
    expect(h.status.errors.value).toEqual({})
  })

  it('asks the reader for the padded range in the display zone, the objects as stored', async () => {
    const h = harness()
    await h.loader.start()
    const [calendars, range, options] = h.read.mock.calls[0]!
    // Radicale's own expansion is slow on a busy calendar and refused past 10000 occurrences.
    expect(calendars).toEqual([
      { url: A, expand: false },
      { url: B, expand: false },
    ])
    expect(range).toEqual(loadRange(h.store.visibleRange.value, ZONE))
    expect(options).toEqual({ force: false })
  })

  it('reads a calendar the viewer sees as busy times only by its busy times, without a problem', async () => {
    const h = harness({
      collections: [
        collection(A, 'Alpha'),
        collection(B, 'Beta', { readOnly: true, freeBusyOnly: true }),
      ],
    })
    h.data.freeBusy.set(
      B,
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VFREEBUSY',
        'FREEBUSY:20261028T090000Z/20261028T100000Z',
        'END:VFREEBUSY',
        'END:VCALENDAR',
      ].join('\r\n'),
    )
    await h.loader.start()
    expect(h.read.mock.calls[0]![0]).toEqual([
      { url: A, expand: false },
      { url: B, expand: false, freeBusy: true },
    ])
    expect(h.store.calendars.value.find((c) => c.id === idB)).toMatchObject({
      readOnly: true,
      freeBusyOnly: true,
    })
    const busy = h.store.events.value.filter((e) => e.calendarId === idB)
    expect(busy).toEqual([expect.objectContaining({ isBlocked: true, title: '' })])
    expect(h.status.errors.value).toEqual({})
  })

  it('names a calendar shared with the viewer with its owner, and loads without that list too', async () => {
    const SHARED = '/caldav/u/shared-7/'
    const h = harness({
      collections: [
        collection(A, 'Personal Calendar'),
        collection(SHARED, 'Personal Calendar', { readOnly: true }),
      ],
    })
    h.data.shared = [{ id: 7, name: 'Personal Calendar', kind: 'personal', owner: 'Alice Example' }]
    await h.loader.start()
    expect(h.store.calendars.value.map((c) => c.name)).toEqual([
      'Personal Calendar',
      'Personal Calendar (Alice Example)',
    ])

    const without = harness({ collections: [collection(SHARED, 'Personal Calendar')] })
    without.data.failing['/api/shared-calendars'] = new Error('down')
    await without.loader.start()
    expect(without.store.calendars.value.map((c) => c.name)).toEqual(['Personal Calendar'])
    expect(without.status.errors.value).toEqual({})
  })

  it('expands a stored series itself, into occurrences that can be edited one by one', async () => {
    const h = harness({ collections: [collection(A, 'Alpha')] })
    h.data.objects.set(A, [
      object(`${A}series.ics`, 'series', 'Standup', [
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE:20261029T090000Z',
      ]),
    ])
    await h.loader.start()
    const events = h.store.events.value.filter((e) => e.uid === 'series')
    expect(events.map((e) => [e.title, e.recurring, e.recurrenceId, e.href])).toEqual([
      ['Standup', true, '2026-10-28T09:00:00Z', `${A}series.ics`],
      ['Standup', true, '2026-10-30T09:00:00Z', `${A}series.ics`],
    ])
    expect(new Set(events.map((e) => e.id)).size).toBe(2)
  })

  it('names the person’s first calendar after them once, while it has Radicale’s name', async () => {
    const OWN = '/caldav/sub-7/def-calendar/'
    const h = harness({
      collections: [
        collection(OWN, 'Personal Calendar'),
        // someone else's shared one keeps its name
        collection('/caldav/sub-7/shared-3/', 'Personal Calendar', { readOnly: true }),
      ],
    })
    await h.loader.start()
    expect(h.renameCalendar.mock.calls).toEqual([[OWN, 'Alice']])
    expect(h.store.calendars.value.map((c) => c.name)).toEqual(['Alice', 'Personal Calendar'])
    // the next load of the sources does not ask again
    await h.loader.refresh()
    expect(h.renameCalendar).toHaveBeenCalledTimes(1)
  })

  it('leaves a renamed calendar, and its name when the server refuses, without a problem', async () => {
    const renamed = harness({ collections: [collection('/caldav/sub-7/def-calendar/', 'Work')] })
    await renamed.loader.start()
    expect(renamed.renameCalendar).not.toHaveBeenCalled()

    const refused = harness({
      collections: [collection('/caldav/sub-7/def-calendar/', 'Personal Calendar')],
    })
    refused.data.failing.rename = new DavError('forbidden', 'no')
    await refused.loader.start()
    expect(refused.store.calendars.value.map((c) => c.name)).toEqual(['Personal Calendar'])
    expect(refused.status.errors.value).toEqual({})
  })

  it('makes a first calendar called "Personal" for a person without a name', async () => {
    const h = harness({
      collections: [],
      me: {
        id: 7,
        sub: 'sub-7',
        username: null,
        name: null,
        email: null,
        isAdmin: false,
        timeZone: null,
        sidebarOrder: null,
      },
    })
    await h.loader.start()
    expect(h.createCalendar).toHaveBeenCalledWith({ displayName: DEFAULT_CALENDAR_NAME })
  })

  it('starts with no calendar and no events, and a placeholder user, before the load', () => {
    const h = harness()
    expect(h.store.calendars.value).toEqual([])
    expect(h.store.events.value).toEqual([])
    expect(h.store.currentUser.value.name).toBe('')
  })

  it('reads subscriptions through the API fetch, expanding their recurrences', async () => {
    const h = harness({
      collections: [collection(A, 'Alpha')],
      subscriptions: [
        {
          id: 3,
          ref: 'ics:3',
          name: 'Holidays',
          url: 'https://x/h.ics',
          color: null,
          shared: true,
        },
      ],
    })
    h.data.icsText.set('3', fixture('feed.ics'))
    await h.loader.start()
    expect(h.fetchIcs).toHaveBeenCalledWith('3')
    const holidays = h.store.events.value.filter((e) => e.calendarId === 'ics:3')
    // The loaded range is the shown week plus a week on both sides: 19 Oct to 9 Nov.
    expect(holidays.map((e) => e.title).sort()).toEqual([
      'All Saints',
      'Reformation Day',
      'Yearly feast',
    ])
    expect(h.store.calendars.value.map((c) => c.id)).toEqual([idA, 'ics:3'])
    expect(h.store.calendars.value[1]).toMatchObject({ type: 'ical', readOnly: true })
  })
})

describe('the time zone of the user (FR-32)', () => {
  const me = (timeZone: string | null): ApiMe => ({
    id: 7,
    sub: 'sub-7',
    username: 'alice',
    name: 'Alice',
    email: 'alice@example.org',
    isAdmin: false,
    timeZone,
  })

  it('takes the saved zone from the profile before the first events are read', async () => {
    const h = harness({ me: me('Australia/Sydney') })
    await h.loader.start()

    expect(h.userZone.value).toBe('Australia/Sydney')
    // One read, in the zone of the user, and the events are wall-clock times in it (AEDT, UTC+11).
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.read.mock.calls[0]![1]).toEqual(
      loadRange(h.store.visibleRange.value, 'Australia/Sydney'),
    )
    expect(h.store.events.value.map((e) => e.start).sort()).toEqual([
      '2026-10-28T20:00:00',
      '2026-10-28T20:00:00',
    ])
  })

  it('reports no zone when the profile has none, so the browser applies', async () => {
    const h = harness({ me: me(null) })
    h.userZone.value = 'Asia/Tokyo'
    await h.loader.start()
    expect(h.userZone.value).toBeNull()
  })

  it('leaves the zone alone when the profile cannot be loaded', async () => {
    const h = harness({ failing: { '/api/me': new Error('boom') } })
    h.userZone.value = 'Asia/Tokyo'
    await h.loader.start()
    expect(h.userZone.value).toBe('Asia/Tokyo')
  })

  it('loads the events again, in the new zone, when the zone changes', async () => {
    const h = harness()
    await h.loader.start()
    expect(h.store.events.value.map((e) => e.start)).toContain('2026-10-28T10:00:00')
    h.read.mockClear()

    h.userZone.value = 'Asia/Tokyo'
    await settle()
    expect(h.timers.delays()).toEqual([150])
    await h.timers.fire()

    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.read.mock.calls[0]![1]).toEqual(loadRange(h.store.visibleRange.value, 'Asia/Tokyo'))
    expect(h.store.events.value.map((e) => e.start).sort()).toEqual([
      '2026-10-28T18:00:00',
      '2026-10-28T18:00:00',
    ])
  })

  it('does not load again when a refresh brings the zone that is set already', async () => {
    const h = harness({ me: me('Asia/Tokyo') })
    await h.loader.start()
    h.read.mockClear()
    await h.loader.loadSources()
    await settle()
    expect(h.timers.count()).toBe(0)
    expect(h.read).not.toHaveBeenCalled()
  })
})

describe('the availability collection of the resources', () => {
  const AVAILABILITY = '/caldav/u/resource-availability/'

  it('is no calendar of the sidebar, and is neither read nor reported as a problem', async () => {
    const h = harness({
      collections: [collection(A, 'Alpha'), collection(AVAILABILITY, 'Availability')],
    })
    await h.loader.start()
    expect(h.store.calendars.value.map((c) => c.name)).toEqual(['Alpha'])
    expect(h.status.errors.value).toEqual({})
    const read = h.read.mock.calls.flatMap(([calendars]) =>
      (calendars as ReadCalendar[]).map((c) => c.url),
    )
    expect(read).not.toContain(AVAILABILITY)
  })

  it('does not stop a user with no calendar of their own from getting the first one', async () => {
    const h = harness({ collections: [collection(AVAILABILITY, 'Availability')] })
    await h.loader.start()
    expect(h.createCalendar).toHaveBeenCalledTimes(1)
    // named after the person (their name from /api/me)
    expect(h.store.calendars.value.map((c) => c.name)).toEqual(['Alice'])
  })
})

describe('the first calendar', () => {
  it('creates one named after the person when the first listing worked and is empty', async () => {
    const h = harness({ collections: [] })
    await h.loader.start()
    expect(h.createCalendar).toHaveBeenCalledTimes(1)
    expect(h.createCalendar).toHaveBeenCalledWith({ displayName: 'Alice' })
    expect(h.store.calendars.value.map((c) => c.name)).toEqual(['Alice'])
    expect(h.store.visibleCalendarIds.value).toEqual(['dav:/caldav/u/new/'])
  })

  it('does not create it when there are calendars, nor when the listing failed', async () => {
    const some = harness()
    await some.loader.start()
    expect(some.createCalendar).not.toHaveBeenCalled()

    const failing = harness({ collections: [], failing: { caldav: new DavError('network', 'x') } })
    await failing.loader.start()
    expect(failing.createCalendar).not.toHaveBeenCalled()
    expect(failing.status.errors.value).toEqual({ 'source:calendars': 'Not reachable' })
  })

  it('creates it once even if the sources are reloaded while the first load is running', async () => {
    const h = harness({ collections: [] })
    const gate = deferred<DavCalendar[]>()
    h.listCalendars.mockImplementationOnce(() => gate.promise)
    const first = h.loader.start()
    await settle()
    // The settings screen reports a change while the first load still waits for the listing.
    h.sourcesVersion.value++
    await settle()
    gate.resolve([])
    await first
    await settle()
    expect(h.createCalendar).toHaveBeenCalledTimes(1)
    expect(h.store.calendars.value.map((c) => c.name)).toEqual(['Alice'])
  })

  it('does not create it again after a later reload finds none (it was deleted on purpose)', async () => {
    const h = harness({ collections: [] })
    await h.loader.start()
    h.data.collections.length = 0
    await h.loader.refresh()
    expect(h.createCalendar).toHaveBeenCalledTimes(1)
    expect(h.store.calendars.value).toEqual([])
  })

  it('reports a failed creation and tries again on the next load', async () => {
    const h = harness({ collections: [] })
    h.createCalendar.mockRejectedValueOnce(new DavError('forbidden', 'no'))
    await h.loader.start()
    expect(h.status.errors.value['source:calendars']).toBe(
      'Could not create the first calendar: Access denied',
    )
    await h.loader.refresh()
    expect(h.createCalendar).toHaveBeenCalledTimes(2)
    expect(h.status.errors.value).toEqual({})
    expect(h.store.calendars.value).toHaveLength(1)
  })

  it('uses the calendar another tab created at the same moment', async () => {
    const h = harness({ collections: [] })
    h.createCalendar.mockImplementationOnce(async () => {
      h.data.collections.push(collection('/caldav/u/other-tab/', 'Personal'))
      throw new DavError('exists', 'there')
    })
    await h.loader.start()
    expect(h.store.calendars.value.map((c) => c.id)).toEqual(['dav:/caldav/u/other-tab/'])
    expect(h.status.errors.value).toEqual({})
  })
})

describe('failures', () => {
  it('one calendar failing leaves the others loaded and is reported by id', async () => {
    const h = harness()
    h.data.objects.set(B, new DavError('unavailable', 'down'))
    await h.loader.start()
    expect(h.titles()).toEqual(['Alpha meeting'])
    expect(h.status.errors.value).toEqual({ [idB]: 'Server unavailable' })
    expect(h.notifyProblems).toHaveBeenCalledWith([idB])
  })

  it('a failing source is reported and the others still load', async () => {
    const h = harness({
      failing: {
        '/api/views': { statusCode: 500 },
        '/api/me': { statusCode: 401 },
        '/api/categories': new TypeError('Failed to fetch'),
      },
    })
    await h.loader.start()
    expect(h.status.errors.value).toEqual({
      'source:views': 'Server unavailable',
      'source:me': 'Sign-in expired',
      'source:categories': 'Not reachable',
    })
    expect(h.store.calendars.value).toHaveLength(2)
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta meeting'])
  })

  it('works without the preferences: default colours, everything visible', async () => {
    const h = harness({ failing: { '/api/calendar-prefs': { statusCode: 503 } } })
    await h.loader.start()
    expect(h.store.visibleCalendarIds.value).toEqual([idA, idB])
    expect(h.status.errors.value).toEqual({ 'source:prefs': 'Server unavailable' })
  })

  it('a failing subscription is worded by the proxy’s reason, not with its URL', async () => {
    const h = harness({
      collections: [collection(A, 'Alpha')],
      subscriptions: [
        {
          id: 3,
          ref: 'ics:3',
          name: 'Feed',
          url: 'https://x/secret.ics?k=1',
          color: null,
          shared: false,
        },
      ],
    })
    h.data.icsText.set('3', { status: 502, reason: 'timeout' })
    await h.loader.start()
    expect(h.status.errors.value).toEqual({ 'ics:3': 'Source took too long' })
    expect(h.titles()).toEqual(['Alpha meeting'])
  })

  it('unreadable entries are counted, not failed', async () => {
    const h = harness()
    h.data.objects.set(A, [
      { url: `${A}bad.ics`, etag: '"x"', data: fixture('mixed-good-bad.ics') },
      object(`${A}one.ics`, 'one', 'Alpha meeting'),
    ])
    await h.loader.start()
    expect(h.status.errors.value).toEqual({})
    expect(h.status.skipped.value[idA]).toBeGreaterThanOrEqual(1)
    expect(h.titles()).toContain('Alpha meeting')
  })

  it('keeps the events a calendar had when a reload of it fails, and clears the error on success', async () => {
    const h = harness()
    await h.loader.start()
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta meeting'])

    h.data.objects.set(B, new DavError('network', 'offline'))
    await h.loader.refresh()
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta meeting'])
    expect(h.status.errors.value).toEqual({ [idB]: 'Not reachable' })

    h.data.objects.set(B, [object(`${B}two.ics`, 'two', 'Beta moved')])
    await h.loader.refresh()
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta moved'])
    expect(h.status.errors.value).toEqual({})
  })

  it('ignores a cancelled read: no error, nothing replaced', async () => {
    const h = harness()
    await h.loader.start()
    h.data.objects.set(A, new DavError('aborted', 'cancelled'))
    await h.loader.refresh()
    expect(h.status.errors.value).toEqual({})
    expect(h.titles()).toContain('Alpha meeting')
  })

  it('only tells about problems that are new', async () => {
    const h = harness()
    h.data.objects.set(B, new DavError('network', 'offline'))
    await h.loader.start()
    await h.loader.refresh()
    expect(h.notifyProblems).toHaveBeenCalledTimes(1)
  })
})

describe('reloading', () => {
  let h: ReturnType<typeof harness>
  beforeEach(async () => {
    h = harness()
    await h.loader.start()
    h.read.mockClear()
  })

  it('loads again 150 ms after the range changed, once for several quick changes', async () => {
    h.store.next()
    h.store.next()
    h.store.next()
    await settle()
    expect(h.timers.delays()).toEqual([150])
    expect(h.read).not.toHaveBeenCalled()
    await h.timers.fire()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.read.mock.calls[0]![1]).toEqual(loadRange(h.store.visibleRange.value, ZONE))
  })

  it('does not reload for a change that keeps the loaded range', async () => {
    h.store.anchorDate.value = anchor.add({ days: 1 }) // still the same week
    h.store.viewType.value = 'week'
    await settle()
    expect(h.timers.count()).toBe(0)
  })

  it('loads the events of a calendar that was switched on, and drops those of one switched off', async () => {
    h.store.setCalendarVisible(idB, false)
    await settle()
    await h.timers.fire()
    expect(h.titles()).toEqual(['Alpha meeting'])
    expect(h.readUrls()).toEqual([[A]])

    h.store.setCalendarVisible(idB, true)
    await settle()
    await h.timers.fire()
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta meeting'])
  })

  it('removes the problem of a calendar that is switched off', async () => {
    h.data.objects.set(B, new DavError('network', 'x'))
    await h.loader.refresh()
    expect(h.status.errors.value).toEqual({ [idB]: 'Not reachable' })
    h.store.setCalendarVisible(idB, false)
    await settle()
    await h.timers.fire()
    expect(h.status.errors.value).toEqual({})
  })

  it('keeps the previous events on screen while the next load runs', async () => {
    const gate = deferred<ReadResult[]>()
    h.read.mockImplementationOnce(() => gate.promise)
    h.store.next()
    await settle()
    await h.timers.fire()
    expect(h.status.loading.value).toBe(true)
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta meeting'])
    gate.resolve([
      { calendarUrl: A, objects: [] },
      { calendarUrl: B, objects: [] },
    ])
    await settle()
    expect(h.status.loading.value).toBe(false)
    expect(h.titles()).toEqual([])
  })

  it('ignores an old response that arrives after a newer one', async () => {
    const slow = deferred<ReadResult[]>()
    h.read.mockImplementationOnce(() => slow.promise)
    h.store.setCalendarVisible(idB, false)
    await settle()
    await h.timers.fire() // request 1 (reads Alpha only): slow

    h.store.setCalendarVisible(idB, true)
    await settle()
    h.data.objects.set(A, [object(`${A}new.ics`, 'new', 'Newest')])
    await h.timers.fire() // request 2 (Alpha and Beta): answers at once
    expect(h.titles()).toEqual(['Beta meeting', 'Newest'])

    slow.resolve([{ calendarUrl: A, objects: [object(`${A}old.ics`, 'old', 'Stale')] }])
    await settle()
    expect(h.titles()).toEqual(['Beta meeting', 'Newest'])
    expect(h.status.loading.value).toBe(false)
  })

  it('refresh reloads the sources and forces the events past the cache', async () => {
    h.api.mockClear()
    h.listCalendars.mockClear()
    await h.loader.refresh()
    expect(h.listCalendars).toHaveBeenCalledTimes(1)
    expect(h.api).toHaveBeenCalledWith('/api/ical-subscriptions')
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.read.mock.calls[0]![2]).toEqual({ force: true })
  })

  it('refresh shows a calendar the server has now, and hides one it no longer has', async () => {
    h.data.collections = [collection(B, 'Beta'), collection('/caldav/u/c/', 'Gamma')]
    h.data.objects.set('/caldav/u/c/', [object('/caldav/u/c/x.ics', 'x', 'Gamma meeting')])
    await h.loader.refresh()
    expect(h.store.calendars.value.map((c) => c.name)).toEqual(['Beta', 'Gamma'])
    expect(h.titles()).toEqual(['Beta meeting', 'Gamma meeting'])
  })

  it('refresh keeps what the viewer switched off', async () => {
    h.store.setCalendarVisible(idB, false)
    await h.loader.refresh()
    expect(h.store.visibleCalendarIds.value).toEqual([idA])
  })

  it('retry loads only the failed calendar, forced, and merges its events', async () => {
    h.data.objects.set(B, new DavError('unavailable', 'down'))
    await h.loader.refresh()
    expect(h.status.errors.value).toEqual({ [idB]: 'Server unavailable' })
    h.read.mockClear()

    h.data.objects.set(B, [object(`${B}two.ics`, 'two', 'Beta again')])
    await h.loader.retry(idB)
    expect(h.readUrls()).toEqual([[B]])
    expect(h.read.mock.calls[0]![2]).toEqual({ force: true })
    expect(h.status.errors.value).toEqual({})
    expect(h.titles()).toEqual(['Alpha meeting', 'Beta again'])
  })

  it('retry of a source reloads the sources', async () => {
    h.data.failing['/api/views'] = { statusCode: 500 }
    await h.loader.refresh()
    expect(h.status.errors.value).toEqual({ 'source:views': 'Server unavailable' })
    delete h.data.failing['/api/views']
    await h.loader.retry('source:views')
    expect(h.status.errors.value).toEqual({})
  })

  it('reloads the sources and the events when the settings bump the sources version', async () => {
    h.data.subscriptions = [
      { id: 3, ref: 'ics:3', name: 'Holidays', url: 'https://x/h.ics', color: null, shared: true },
    ]
    h.data.icsText.set('3', fixture('feed.ics'))
    h.sourcesVersion.value++
    await settle()
    expect(h.store.calendars.value.map((c) => c.id)).toEqual([idA, idB, 'ics:3'])
    // A calendar that appeared starts as its preference says (visible) and is read.
    expect(h.store.visibleCalendarIds.value).toEqual([idA, idB, 'ics:3'])
    expect(h.fetchIcs).toHaveBeenCalledWith('3')
    expect(h.read.mock.calls.at(-1)![2]).toEqual({ force: true })
  })

  it('stops reacting after dispose', async () => {
    h.loader.dispose()
    h.store.next()
    h.sourcesVersion.value++
    await settle()
    expect(h.timers.count()).toBe(0)
    expect(h.read).not.toHaveBeenCalled()
  })
})

describe('categories', () => {
  it('links events to a category the viewer creates afterwards', async () => {
    const h = harness()
    h.data.objects.set(A, [object(`${A}one.ics`, 'one', 'Alpha meeting', ['CATEGORIES:Fun'])])
    await h.loader.start()
    expect(h.store.events.value.find((e) => e.uid === 'one')!.categoryIds).toEqual(['auto:fun'])

    const created = h.store.addCategory('fun')
    expect(created).not.toBeNull()
    await settle()
    const id = created!.id
    expect(h.store.categories.value.map((c) => c.id)).toEqual([id])
    expect(h.store.events.value.find((e) => e.uid === 'one')!.categoryIds).toEqual([id])
  })

  it('keeps an auto category when the viewer moves to a week without it', async () => {
    const h = harness()
    h.data.objects.set(A, [object(`${A}one.ics`, 'one', 'Alpha meeting', ['CATEGORIES:Fun'])])
    await h.loader.start()
    h.store.setCategorySelected('auto:fun', true)
    h.data.objects.set(A, [])
    h.store.next()
    await settle()
    await h.timers.fire()
    expect(h.store.categories.value.map((c) => c.id)).toEqual(['auto:fun'])
  })

  it('moves a selected auto category to the real one the viewer creates, so events stay visible', async () => {
    const h = harness()
    h.data.objects.set(A, [object(`${A}one.ics`, 'one', 'Alpha meeting', ['CATEGORIES:Fun'])])
    await h.loader.start()
    h.store.setCategorySelected('auto:fun', true)
    expect(h.store.visibleEvents.value.map((e) => e.uid)).toEqual(['one'])

    const created = h.store.addCategory('fun')!
    await settle()
    expect(h.store.selectedCategoryIds.value).toEqual([created.id])
    expect(h.store.visibleEvents.value.map((e) => e.uid)).toEqual(['one'])
  })

  it('drops a selected category that is gone after a reload, so the calendar is not left empty', async () => {
    const h = harness({ categories: [{ id: 1, name: 'Work', color: '#112233', shared: false }] })
    h.data.objects.set(A, [object(`${A}one.ics`, 'one', 'Alpha meeting', ['CATEGORIES:Work'])])
    await h.loader.start()
    h.store.setCategorySelected('1', true)
    expect(h.store.visibleEvents.value.map((e) => e.uid)).toEqual(['one'])

    h.data.categories = []
    await h.loader.refresh()
    expect(h.store.selectedCategoryIds.value).toEqual([])
    // Nothing is selected any more, so all events show; the one that had the category keeps its
    // name as an auto category.
    expect(h.store.visibleEvents.value.map((e) => e.uid)).toEqual(['one', 'two'])
    expect(h.store.events.value.find((e) => e.uid === 'one')!.categoryIds).toEqual(['auto:work'])
  })

  it('drops a selected auto category nobody carries any more', async () => {
    const h = harness()
    await h.loader.start()
    h.store.categories.value = [{ id: 'auto:old', name: 'Old', color: '#000000' }]
    h.store.setCategorySelected('auto:old', true)
    h.store.categories.value = []
    await settle()
    expect(h.store.selectedCategoryIds.value).toEqual([])
  })
})
