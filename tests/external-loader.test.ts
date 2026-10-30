import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import type { ExternalAccount } from '../shared/types/external'
import { createCalendarState, type StateFactory } from '../app/utils/calendar-state'
import { DavError } from '../app/utils/caldav/errors'
import type { ReadCalendar, ReadResult } from '../app/utils/caldav/reader'
import type { DavCalendar, DavObject, DavRange } from '../app/utils/caldav/types'
import type { ApiCalendarPref } from '../app/utils/live/api-types'
import { externalAccountKey, EXTERNAL_LIST_KEY } from '../app/utils/live/errors'
import { loadRange } from '../app/utils/live/range'
import { createLiveLoader } from '../app/utils/live/loader'
import { emptySeed } from '../app/utils/live/seed'
import { createLiveStatusState } from '../app/utils/live/status'
import { PALETTE } from '../app/utils/live/palette'
import type { ExternalSource } from '../app/utils/external/source'
import { calendar as ics, vevent } from './ical-read-helpers'
import { HOST, account } from './external-helpers'

// The loader with external accounts: a fake source stands in for the accounts' servers. What
// matters here is NFR-4: one account failing, or being slow, never holds back or breaks another
// calendar.

const anchor = Temporal.PlainDate.from('2026-10-28') // a Wednesday; the week starts 2026-10-26
const ZONE = 'Europe/Berlin'
const A = '/caldav/u/a/'

const WORK = `${HOST}/dav/work/`
const MISC = `${HOST}/dav/misc/`
const TEAM = 'https://cal.example.net/team/'
const idWork = `ext:1:${WORK}`
const idMisc = `ext:1:${MISC}`
const idTeam = `ext:2:${TEAM}`

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
    readOnly: true,
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

function manualTimers() {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    set: (callback: () => void) => {
      pending.set(next, callback)
      return next++
    },
    clear: (handle: unknown) => {
      pending.delete(handle as number)
    },
    fire: async () => {
      const due = [...pending.values()]
      pending.clear()
      for (const callback of due) callback()
      await settle()
    },
  }
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Listing = DavCalendar[] | Error | Promise<DavCalendar[]>

interface Setup {
  accounts?: ExternalAccount[]
  listings?: Record<number, Listing>
  prefs?: ApiCalendarPref[]
  /** Fails the built-in listing. */
  builtInFails?: boolean
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
  const timers = manualTimers()

  const data = {
    accounts: setup.accounts ?? [
      account(1, { name: 'One' }),
      account(2, { name: 'Two', url: 'https://cal.example.net/', color: '#112233' }),
    ],
    accountsFail: null as unknown,
    prefs: setup.prefs ?? [],
    listings: {
      1: [collection(WORK, 'Work', { color: '#abcdef' }), collection(MISC, 'Misc')],
      2: [collection(TEAM, 'Team', { color: '#ffffff' })],
      ...setup.listings,
    } as Record<number, Listing>,
    /** calendar URL -> what the reader returns for it */
    objects: new Map<string, DavObject[] | DavError>([
      [WORK, [object(`${WORK}1.ics`, 'work-1', 'Work meeting')]],
      [MISC, [object(`${MISC}1.ics`, 'misc-1', 'Misc meeting')]],
      [TEAM, [object(`${TEAM}1.ics`, 'team-1', 'Team meeting')]],
    ]),
    builtInFails: setup.builtInFails ?? false,
  }

  const api = vi.fn(async (path: string): Promise<unknown> => {
    switch (path) {
      case '/api/me':
        return {
          id: 7,
          sub: 'sub-7',
          username: 'a',
          name: 'A',
          email: null,
          isAdmin: false,
          timeZone: null,
        }
      case '/api/calendar-prefs':
        return { prefs: data.prefs }
      case '/api/categories':
        return { categories: [] }
      case '/api/filters':
        return { filters: [] }
      case '/api/views':
        return { views: [] }
      case '/api/ical-subscriptions':
        return { subscriptions: [] }
      default:
        throw new Error(`unexpected request ${path}`)
    }
  })

  const builtIn = vi.fn(async () => {
    if (data.builtInFails) throw new DavError('network', 'down')
    return [
      {
        url: A,
        displayName: 'Alpha',
        color: null,
        ctag: null,
        components: ['VEVENT'],
        readOnly: false,
      } satisfies DavCalendar,
    ]
  })
  const builtInRead = vi.fn(async (calendars: readonly ReadCalendar[]): Promise<ReadResult[]> =>
    calendars.map((c) => ({
      calendarUrl: c.url,
      objects: [object(`${A}1.ics`, 'alpha-1', 'Alpha meeting')],
    })),
  )

  const listAccounts = vi.fn(async () => {
    if (data.accountsFail) throw data.accountsFail
    return { accounts: data.accounts.slice(), loginsEnabled: true }
  })
  const listCalendars = vi.fn(async (target: ExternalAccount): Promise<DavCalendar[]> => {
    const listing = data.listings[target.id]
    if (listing instanceof Error) throw listing
    return (await listing) ?? []
  })
  const read = vi.fn(
    async (
      target: ExternalAccount,
      calendars: readonly ReadCalendar[],
      _range: DavRange,
      _options?: { force?: boolean },
    ): Promise<ReadResult[]> =>
      calendars.map((c) => {
        const found = data.objects.get(c.url)
        return found instanceof DavError
          ? { calendarUrl: c.url, error: found }
          : { calendarUrl: c.url, objects: found ?? [] }
      }),
  )
  const external: ExternalSource = { listAccounts, listCalendars, read }
  const notifyProblems = vi.fn()

  const loader = createLiveLoader({
    store,
    status,
    client: { listCalendars: builtIn, createCalendar: vi.fn() } as never,
    reader: { read: builtInRead },
    api: api as never,
    fetchIcs: vi.fn(),
    external,
    displayTimeZone: () => ZONE,
    orgTimeZone: () => ZONE,
    sourcesVersion,
    notifyProblems,
    timers,
    now: () => 1_700_000_000_000,
  })
  return {
    store,
    status,
    data,
    loader,
    listAccounts,
    listCalendars,
    read,
    builtIn,
    builtInRead,
    notifyProblems,
    sourcesVersion,
    timers,
    titles: () => store.events.value.map((e) => e.title).sort(),
    ids: () => store.calendars.value.map((c) => c.id),
    errors: () => status.errors.value,
    readCalls: (id?: number) =>
      read.mock.calls.filter(([target]) => id === undefined || target.id === id),
  }
}

describe('the calendars of the accounts', () => {
  it('adds them after the built-in ones: ref, read-only, account id, name from the server', async () => {
    const h = harness()
    await h.loader.start()
    expect(h.ids()).toEqual([`dav:${A}`, idWork, idMisc, idTeam])
    expect(h.store.calendars.value.slice(1)).toEqual([
      expect.objectContaining({
        id: idWork,
        name: 'Work',
        type: 'caldav',
        readOnly: true,
        caldavAccountId: '1',
        href: WORK,
        defaultVisible: true,
      }),
      expect.objectContaining({ id: idMisc, name: 'Misc', caldavAccountId: '1', href: MISC }),
      expect.objectContaining({ id: idTeam, name: 'Team', caldavAccountId: '2', href: TEAM }),
    ])
    expect(h.store.visibleCalendarIds.value).toEqual([`dav:${A}`, idWork, idMisc, idTeam])
    expect(h.status.externalAccounts.value.map((a) => a.id)).toEqual([1, 2])
  })

  it('colours them: the viewer’s choice, else the account’s, else the server’s, else the palette', async () => {
    const h = harness({ prefs: [{ ref: idWork, color: '#010203', visible: true }] })
    await h.loader.start()
    const color = (id: string) => h.store.calendars.value.find((c) => c.id === id)!.color
    expect(color(idWork)).toBe('#010203') // the viewer's own choice beats the server's #abcdef
    expect(color(idTeam)).toBe('#112233') // the account's colour beats the server's #ffffff
    // No colour from anywhere: the palette by position in the whole list (Alpha, Work, Misc, ...).
    expect(color(idMisc)).toBe(PALETTE[2])
  })

  it('uses the server’s colour when the account has none', async () => {
    const h = harness()
    await h.loader.start()
    expect(h.store.calendars.value.find((c) => c.id === idWork)!.color).toBe('#abcdef')
  })

  it('applies the viewer’s preference: a calendar switched off is not read', async () => {
    const h = harness({ prefs: [{ ref: idMisc, color: null, visible: false }] })
    await h.loader.start()
    expect(h.store.visibleCalendarIds.value).not.toContain(idMisc)
    const readUrls = h.read.mock.calls.flatMap(([, calendars]) => calendars.map((c) => c.url))
    expect(readUrls.sort()).toEqual([TEAM, WORK])
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting', 'Work meeting'])
  })

  it('reads them without the server expanding series, once per account, for the padded range', async () => {
    const h = harness()
    await h.loader.start()
    expect(h.readCalls()).toHaveLength(2)
    const [, calendars, range, options] = h.readCalls(1)[0]!
    expect(calendars).toEqual([
      { url: WORK, expand: false },
      { url: MISC, expand: false },
    ])
    expect(range).toEqual(loadRange(h.store.visibleRange.value, ZONE))
    expect(options).toEqual({ force: false })
  })

  it('expands a repeating event itself, because the server did not', async () => {
    const h = harness()
    h.data.objects.set(WORK, [
      object(`${WORK}weekly.ics`, 'weekly', 'Weekly', ['RRULE:FREQ=WEEKLY;COUNT=10']),
    ])
    await h.loader.start()
    // The loaded range is the shown week plus a week on both sides: 19 Oct to 9 Nov.
    expect(h.store.events.value.filter((e) => e.calendarId === idWork)).toHaveLength(2)
  })

  it('gives the events the ref of their calendar and keeps them read-only', async () => {
    const h = harness()
    await h.loader.start()
    const event = h.store.events.value.find((e) => e.title === 'Team meeting')!
    expect(event.calendarId).toBe(idTeam)
    expect(h.store.calendars.value.find((c) => c.id === event.calendarId)!.readOnly).toBe(true)
  })

  it('loads the events again for a new range, one read per account', async () => {
    const h = harness()
    await h.loader.start()
    h.read.mockClear()
    h.store.anchorDate.value = anchor.add({ days: 14 })
    await settle()
    await h.timers.fire()
    expect(h.readCalls()).toHaveLength(2)
    expect(h.readCalls(2)[0]![2]).toEqual(loadRange(h.store.visibleRange.value, ZONE))
    expect(h.readCalls(2)[0]![3]).toEqual({ force: false })
  })

  it('refresh reads everything again past the cache, built-in and external', async () => {
    const h = harness()
    await h.loader.start()
    h.read.mockClear()
    h.builtInRead.mockClear()
    await h.loader.refresh()
    expect(h.readCalls().map(([, , , options]) => options)).toEqual([
      { force: true },
      { force: true },
    ])
    expect(h.builtInRead).toHaveBeenCalledTimes(1)
    // and the calendars are listed again, once each
    expect(h.listCalendars).toHaveBeenCalledTimes(4)
    expect(h.ids()).toEqual([`dav:${A}`, idWork, idMisc, idTeam])
  })

  it('leaves the accounts alone when asked to: what a write to the built-in service needs', async () => {
    const h = harness()
    await h.loader.start()
    h.read.mockClear()
    h.listCalendars.mockClear()
    h.listAccounts.mockClear()
    h.builtInRead.mockClear()
    // An account that would take a long time must not delay it.
    h.data.listings[1] = deferred<DavCalendar[]>().promise
    await h.loader.refresh({ external: false })
    expect(h.builtInRead).toHaveBeenCalledTimes(1)
    expect(h.listAccounts).not.toHaveBeenCalled()
    expect(h.listCalendars).not.toHaveBeenCalled()
    expect(h.read).not.toHaveBeenCalled()
    expect(h.titles()).toEqual(['Alpha meeting', 'Misc meeting', 'Team meeting', 'Work meeting'])
    expect(h.status.loading.value).toBe(false)
  })

  it('does not read twice when a refresh also finds the calendars again', async () => {
    const h = harness()
    await h.loader.start()
    h.read.mockClear()
    await h.loader.refresh()
    expect(h.readCalls(1)).toHaveLength(1)
    expect(h.readCalls(2)).toHaveLength(1)
  })

  it('removes the events of a calendar that is switched off', async () => {
    const h = harness()
    await h.loader.start()
    h.store.setCalendarVisible(idTeam, false)
    await settle()
    await h.timers.fire()
    expect(h.titles()).toEqual(['Alpha meeting', 'Misc meeting', 'Work meeting'])
  })

  it('knows no account without the dependency (the loader as it was)', async () => {
    const state = memoryState()
    const store = createCalendarState(state, {
      seed: emptySeed,
      today: () => anchor,
      sidebarOpen: () => true,
    })
    const loader = createLiveLoader({
      store,
      status: createLiveStatusState(state),
      client: {
        listCalendars: async () => [],
        createCalendar: vi.fn(async () => collection(A, 'P')),
      } as never,
      reader: { read: vi.fn(async () => []) },
      api: (async (path: string) => {
        if (path === '/api/me')
          return {
            id: 1,
            sub: 's',
            username: null,
            name: null,
            email: null,
            isAdmin: false,
            timeZone: null,
          }
        return path === '/api/calendar-prefs'
          ? { prefs: [] }
          : { categories: [], filters: [], views: [], subscriptions: [] }
      }) as never,
      fetchIcs: vi.fn(),
      displayTimeZone: () => ZONE,
      orgTimeZone: () => ZONE,
      sourcesVersion: ref(0),
    })
    await loader.start()
    expect(store.calendars.value.map((c) => c.id)).toEqual([`dav:${A}`])
  })
})

describe('one account never holds back or breaks another calendar (NFR-4)', () => {
  it('shows the built-in calendars and the fast account while a slow account has not answered', async () => {
    const slow = deferred<DavCalendar[]>()
    const h = harness({ listings: { 1: slow.promise } })
    const started = h.loader.start()
    await settle()

    // The built-in calendar and account 2 are there; account 1 is still being asked.
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting'])
    expect(h.ids()).toEqual([`dav:${A}`, idTeam])
    expect(h.status.loading.value).toBe(true)

    slow.resolve([collection(WORK, 'Work')])
    await started
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting', 'Work meeting'])
    expect(h.status.loading.value).toBe(false)
  })

  it('reports an account that cannot be listed once, by name, and loads the others', async () => {
    const h = harness({ listings: { 1: new DavError('network', 'down') } })
    await h.loader.start()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Not reachable' })
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting'])
    expect(h.ids()).toEqual([`dav:${A}`, idTeam])
    expect(h.notifyProblems).toHaveBeenCalledWith([externalAccountKey(1)])
    expect(h.status.passwordFor.value).toEqual({})
  })

  it('does not let a throw that is no DavError break the others', async () => {
    const h = harness({ listings: { 1: new TypeError('Failed to fetch') } })
    await h.loader.start()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Not reachable' })
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting'])
  })

  it('reports a calendar that cannot be read by its own ref and loads its neighbours', async () => {
    const h = harness()
    h.data.objects.set(MISC, new DavError('unavailable', 'busy'))
    await h.loader.start()
    expect(h.errors()).toEqual({ [idMisc]: 'Server unavailable' })
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting', 'Work meeting'])
  })

  it('retries one failed calendar alone, past the cache', async () => {
    const h = harness()
    h.data.objects.set(MISC, new DavError('unavailable', 'busy'))
    await h.loader.start()
    h.data.objects.set(MISC, [object(`${MISC}1.ics`, 'misc-1', 'Misc meeting')])
    h.read.mockClear()
    await h.loader.retry(idMisc)
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.read.mock.calls[0]![1]).toEqual([{ url: MISC, expand: false }])
    expect(h.read.mock.calls[0]![3]).toEqual({ force: true })
    expect(h.errors()).toEqual({})
    expect(h.titles()).toContain('Misc meeting')
  })

  it('retries an account by loading all sources again', async () => {
    const h = harness({ listings: { 1: new DavError('network', 'down') } })
    await h.loader.start()
    h.data.listings[1] = [collection(WORK, 'Work')]
    await h.loader.retry(externalAccountKey(1))
    expect(h.errors()).toEqual({})
    expect(h.ids()).toEqual([`dav:${A}`, idWork, idTeam])
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting', 'Work meeting'])
  })

  it('keeps the calendars and events an account had when its listing fails later', async () => {
    const h = harness()
    await h.loader.start()
    h.data.listings[1] = new DavError('network', 'down')
    await h.loader.refresh()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Not reachable' })
    expect(h.ids()).toEqual([`dav:${A}`, idWork, idMisc, idTeam])
    expect(h.titles()).toEqual(['Alpha meeting', 'Misc meeting', 'Team meeting', 'Work meeting'])
  })

  it('keeps the external calendars, once, when the built-in listing fails', async () => {
    const h = harness()
    await h.loader.start()
    h.data.builtInFails = true
    await h.loader.loadSources()
    // The built-in calendar is kept as it was, the external ones are not duplicated.
    expect(h.ids()).toEqual([`dav:${A}`, idWork, idMisc, idTeam])
    expect(h.errors()).toEqual({ 'source:calendars': 'Not reachable' })
  })

  it('keeps an account’s problem when the sources are loaded again, and clears it when it is cured', async () => {
    const h = harness({ listings: { 1: new DavError('network', 'down') } })
    await h.loader.start()
    await h.loader.loadSources()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Not reachable' })

    h.data.listings[1] = [collection(WORK, 'Work')]
    await h.loader.refresh()
    expect(h.errors()).toEqual({})
  })

  it('reports a list of accounts that cannot be read, and keeps the accounts it knew', async () => {
    const h = harness()
    await h.loader.start()
    h.data.accountsFail = new DavError('unavailable', 'x')
    await h.loader.refresh()
    expect(h.errors()).toEqual({ [EXTERNAL_LIST_KEY]: 'Server unavailable' })
    expect(h.ids()).toEqual([`dav:${A}`, idWork, idMisc, idTeam])
    expect(h.titles()).toHaveLength(4)

    h.data.accountsFail = null
    await h.loader.refresh()
    expect(h.errors()).toEqual({})
  })

  it('reports the failure of the list of accounts without touching the built-in calendars', async () => {
    const h = harness()
    h.data.accountsFail = Object.assign(new Error('boom'), { statusCode: 500 })
    await h.loader.start()
    expect(h.errors()).toEqual({ [EXTERNAL_LIST_KEY]: 'Server unavailable' })
    expect(h.titles()).toEqual(['Alpha meeting'])
  })

  it('drops an account that was deleted: its calendars, events and problems', async () => {
    const h = harness({ listings: { 1: new DavError('network', 'down') } })
    h.data.objects.set(TEAM, new DavError('unavailable', 'busy'))
    await h.loader.start()
    expect(Object.keys(h.errors()).sort()).toEqual([externalAccountKey(1), idTeam].sort())

    h.data.accounts = h.data.accounts.filter((a) => a.id !== 1)
    await h.loader.refresh()
    expect(Object.keys(h.errors())).toEqual([idTeam])

    h.data.accounts = []
    await h.loader.refresh()
    expect(h.errors()).toEqual({})
    expect(h.ids()).toEqual([`dav:${A}`])
    expect(h.titles()).toEqual(['Alpha meeting'])
    expect(h.store.visibleCalendarIds.value).toEqual([`dav:${A}`])
  })

  it('does not let an older run overwrite a newer one', async () => {
    const first = deferred<DavCalendar[]>()
    const h = harness({ listings: { 1: first.promise } })
    const started = h.loader.start()
    await settle()
    // A change of sources while the first run waits for the slow server.
    h.data.listings[1] = [collection(MISC, 'Misc')]
    const second = h.loader.refresh()
    await settle()
    first.resolve([collection(WORK, 'Work')])
    await Promise.all([started, second])
    expect(h.ids()).toEqual([`dav:${A}`, idMisc, idTeam])
  })

  it('writes nothing after it is disposed', async () => {
    const slow = deferred<DavCalendar[]>()
    const h = harness({ listings: { 1: slow.promise } })
    const started = h.loader.start()
    await settle()
    h.loader.dispose()
    slow.resolve([collection(WORK, 'Work')])
    await started
    expect(h.ids()).not.toContain(idWork)
  })
})

describe('logins', () => {
  it('shows one problem for an account whose login fails in all of its calendars, with the way out', async () => {
    const h = harness()
    const rejected = new DavError('login-rejected', 'no')
    h.data.objects.set(WORK, rejected)
    h.data.objects.set(MISC, rejected)
    await h.loader.start()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Login rejected' })
    expect(h.status.passwordFor.value).toEqual({ [externalAccountKey(1)]: 1 })
    expect(h.titles()).toEqual(['Alpha meeting', 'Team meeting'])
  })

  it('offers the password for a listing that needs one, and only for that account', async () => {
    const h = harness({ listings: { 2: new DavError('credential-needed', 'none') } })
    await h.loader.start()
    expect(h.errors()).toEqual({ [externalAccountKey(2)]: 'Password needed' })
    expect(h.status.passwordFor.value).toEqual({ [externalAccountKey(2)]: 2 })
    expect(h.titles()).toEqual(['Alpha meeting', 'Misc meeting', 'Work meeting'])
  })

  it('offers nothing for problems a password cannot cure', async () => {
    const h = harness({ listings: { 1: new DavError('host-not-allowed', 'no') } })
    await h.loader.start()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Server not allowed' })
    expect(h.status.passwordFor.value).toEqual({})
  })

  it('clears the problem and the offer when the login works again', async () => {
    const h = harness()
    h.data.objects.set(WORK, new DavError('login-rejected', 'no'))
    h.data.objects.set(MISC, new DavError('login-rejected', 'no'))
    await h.loader.start()
    h.data.objects.set(WORK, [object(`${WORK}1.ics`, 'work-1', 'Work meeting')])
    h.data.objects.set(MISC, [object(`${MISC}1.ics`, 'misc-1', 'Misc meeting')])
    await h.loader.refresh()
    expect(h.errors()).toEqual({})
    expect(h.status.passwordFor.value).toEqual({})
    expect(h.titles()).toHaveLength(4)
  })

  it('clears the offer when the problem becomes another one', async () => {
    const h = harness({ listings: { 1: new DavError('credential-needed', 'none') } })
    await h.loader.start()
    h.data.listings[1] = new DavError('network', 'down')
    await h.loader.refresh()
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Not reachable' })
    expect(h.status.passwordFor.value).toEqual({})
  })

  it('keeps the events of an account whose login failed until it works again (nothing flashes)', async () => {
    const h = harness()
    await h.loader.start()
    h.data.objects.set(WORK, new DavError('login-rejected', 'no'))
    h.data.objects.set(MISC, new DavError('login-rejected', 'no'))
    await h.loader.refresh()
    expect(h.titles()).toEqual(['Alpha meeting', 'Misc meeting', 'Team meeting', 'Work meeting'])
    expect(h.errors()).toEqual({ [externalAccountKey(1)]: 'Login rejected' })
  })
})
