import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import type { ExternalAccount } from '../shared/types/external'
import { createCalendarState, type StateFactory } from '../app/utils/calendar-state'
import { createLiveLoader } from '../app/utils/live/loader'
import { emptySeed } from '../app/utils/live/seed'
import { createLiveStatusState } from '../app/utils/live/status'
import { externalAccountKey } from '../app/utils/live/errors'
import { createSealStore } from '../app/utils/external/seals'
import { createExternalSource } from '../app/utils/external/source'
import {
  HOST,
  ICS,
  SEALED,
  account,
  calendarProps,
  entry,
  eventItem,
  fakeProxy,
  folderProps,
  multistatus,
  ownError,
  type UpstreamCall,
} from './external-helpers'

// The pieces together: the loader, the source with its readers, the account's `fetch`, the seal
// store and a fake of the proxy in front of fake CalDAV servers. These are the guarantees the user
// relies on: the right credential goes to the right account only, one account failing is isolated,
// and a hostile server cannot make the browser request another host.

const anchor = Temporal.PlainDate.from('2026-10-28')
const OTHER = 'https://cal.example.net'

function memoryState(): StateFactory {
  const store = new Map<string, Ref<unknown>>()
  return <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key) as Ref<T>
  }
}

async function settle() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

/** Answers one request for the account. */
type Server = (call: UpstreamCall) => Response | Promise<Response>

/** A server with a home that lists the given calendars and serves `events` for each. */
function davServer(
  home: string,
  calendars: { path: string; name: string; events: string }[],
  hostile: string[] = [],
): Server {
  return (call) => {
    if (call.method === 'PROPFIND' && call.path === home) {
      if (call.headers.get('depth') === '0') return multistatus(entry(home, folderProps))
      return multistatus(
        entry(home, folderProps),
        ...hostile.map((href) => entry(href, calendarProps('Hostile'))),
        ...calendars.map((c) => entry(c.path, calendarProps(c.name))),
      )
    }
    const found = calendars.find((c) => c.path === call.path)
    if (call.method === 'REPORT' && found) {
      return multistatus(
        eventItem(`${found.path}one.ics`, '"e1"', found.events),
        // an event resource on another host must never be requested nor shown
        eventItem(`https://evil.example${found.path}two.ics`, '"e2"', ICS('evil', 'Evil')),
      )
    }
    throw new Error(`unexpected ${call.method} ${call.path}`)
  }
}

function setup(options: {
  accounts: ExternalAccount[]
  servers: Record<number, Server>
  sealed?: Record<number, string>
  onRequest?: (call: UpstreamCall) => Response | undefined
}) {
  const state = memoryState()
  const store = createCalendarState(state, {
    seed: emptySeed,
    today: () => anchor,
    sidebarOpen: () => true,
  })
  const status = createLiveStatusState(state)
  const seals = createSealStore({ userSub: () => 'sub-1', storage: () => null })
  for (const [id, sealed] of Object.entries(options.sealed ?? {}))
    seals.set(Number(id), sealed, false)

  const proxy = fakeProxy((call) => {
    const special = options.onRequest?.(call)
    if (special) return special
    const server = options.servers[call.accountId]
    if (!server) return ownError.accountNotFound()
    return server(call)
  })
  const accounts = { current: options.accounts }
  const source = createExternalSource({
    fetch: proxy.fetch,
    api: { list: async () => ({ accounts: accounts.current, loginsEnabled: true }) },
    seals,
  })
  const loader = createLiveLoader({
    store,
    status,
    client: {
      // One built-in calendar without events: the accounts are what these tests are about.
      listCalendars: async () => [
        {
          url: '/caldav/u/a/',
          displayName: 'Alpha',
          color: null,
          ctag: null,
          components: ['VEVENT'],
          readOnly: false,
        },
      ],
      createCalendar: vi.fn(),
    } as never,
    reader: {
      read: async (calendars: { url: string }[]) =>
        calendars.map((c) => ({ calendarUrl: c.url, objects: [] })),
    },
    api: (async (path: string) => {
      if (path === '/api/me')
        return {
          id: 1,
          sub: 'sub-1',
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
    external: source,
    displayTimeZone: () => 'Europe/Berlin',
    orgTimeZone: () => 'Europe/Berlin',
    sourcesVersion: ref(0),
    timers: { set: () => 0, clear: () => undefined },
  })
  return { store, status, seals, proxy, loader, accounts }
}

const WORK_HOME = '/dav/me/'
const work = davServer(WORK_HOME, [
  { path: `${WORK_HOME}work/`, name: 'Work', events: ICS('w1', 'Work meeting') },
])
const TEAM_HOME = '/team/'
const team = davServer(TEAM_HOME, [
  { path: `${TEAM_HOME}cal/`, name: 'Team', events: ICS('t1', 'Team meeting') },
])

const accountWork = account(1, {
  name: 'Work',
  url: `${HOST}${WORK_HOME}`,
  authMode: 'basic',
  username: 'me',
})
const accountTeam = account(2, { name: 'Team', url: `${OTHER}${TEAM_HOME}` })

describe('accounts through the proxy', () => {
  it('loads each account through its own proxy path, with only its own credential', async () => {
    const h = setup({
      accounts: [accountWork, accountTeam],
      servers: { 1: work, 2: team },
      sealed: { 1: SEALED },
    })
    await h.loader.start()
    await settle()
    expect(h.store.events.value.map((e) => e.title).sort()).toEqual([
      'Team meeting',
      'Work meeting',
    ])
    expect(h.status.errors.value).toEqual({})

    const sealedPerAccount = new Map<number, Set<string | null>>()
    for (const call of h.proxy.calls) {
      const set = sealedPerAccount.get(call.accountId) ?? new Set()
      set.add(call.headers.get('x-upstream-authorization'))
      sealedPerAccount.set(call.accountId, set)
    }
    expect(sealedPerAccount.get(1)).toEqual(new Set([`Sealed ${SEALED}`]))
    expect(sealedPerAccount.get(2)).toEqual(new Set([null]))
    // Everything went to the proxy, and nothing carried a host.
    expect(h.proxy.calls.every((c) => /^\/api\/external\/[12]\/[^/]/.test(c.url))).toBe(true)
  })

  it('reads the events with the reader expanding series, not the server', async () => {
    const weekly = ICS('weekly', 'Weekly').replace(
      'END:VEVENT',
      'RRULE:FREQ=WEEKLY;COUNT=10\r\nEND:VEVENT',
    )
    const h = setup({
      accounts: [accountTeam],
      servers: {
        2: davServer(TEAM_HOME, [{ path: `${TEAM_HOME}cal/`, name: 'Team', events: weekly }]),
      },
    })
    await h.loader.start()
    await settle()
    const report = h.proxy.calls.find((c) => c.method === 'REPORT')!
    expect(report.body).toContain('<c:time-range')
    expect(report.body).not.toContain('expand')
    expect(h.store.events.value.filter((e) => e.title === 'Weekly')).toHaveLength(2)
  })

  it('never requests, nor shows, anything on another host', async () => {
    const h = setup({
      accounts: [accountTeam],
      servers: {
        2: davServer(
          TEAM_HOME,
          [{ path: `${TEAM_HOME}cal/`, name: 'Team', events: ICS('t1', 'Team meeting') }],
          ['https://evil.example/team/stolen/', '//evil.example/team/stolen2/'],
        ),
      },
    })
    await h.loader.start()
    await settle()
    expect(h.store.calendars.value.map((c) => c.id)).toEqual([
      'dav:/caldav/u/a/',
      `ext:2:${OTHER}${TEAM_HOME}cal/`,
    ])
    expect(h.store.events.value.map((e) => e.title)).toEqual(['Team meeting'])
    expect(h.proxy.calls.every((c) => c.accountId === 2 && !c.url.includes('evil'))).toBe(true)
  })

  it('asks for the password of an account that has none here, without any request for it', async () => {
    const h = setup({ accounts: [accountWork, accountTeam], servers: { 1: work, 2: team } })
    await h.loader.start()
    await settle()
    expect(h.status.errors.value).toEqual({ [externalAccountKey(1)]: 'Password needed' })
    expect(h.status.passwordFor.value).toEqual({ [externalAccountKey(1)]: 1 })
    expect(h.proxy.calls.some((c) => c.accountId === 1)).toBe(false)
    expect(h.store.events.value.map((e) => e.title)).toEqual(['Team meeting'])
  })

  it('works after the password is entered and everything is loaded again', async () => {
    const h = setup({ accounts: [accountWork, accountTeam], servers: { 1: work, 2: team } })
    await h.loader.start()
    h.seals.set(1, SEALED, false)
    await h.loader.refresh()
    await settle()
    expect(h.status.errors.value).toEqual({})
    expect(h.status.passwordFor.value).toEqual({})
    expect(h.store.events.value.map((e) => e.title).sort()).toEqual([
      'Team meeting',
      'Work meeting',
    ])
  })

  it('forgets a sealed credential the proxy cannot open (428) and asks again', async () => {
    const h = setup({
      accounts: [accountWork, accountTeam],
      servers: { 1: work, 2: team },
      sealed: { 1: 'stale-seal' },
      onRequest: (call) => (call.accountId === 1 ? ownError.credentialRequired() : undefined),
    })
    await h.loader.start()
    await settle()
    expect(h.seals.has(1)).toBe(false)
    expect(h.status.errors.value).toEqual({ [externalAccountKey(1)]: 'Password needed' })
    expect(h.status.passwordFor.value).toEqual({ [externalAccountKey(1)]: 1 })
    expect(h.store.events.value.map((e) => e.title)).toEqual(['Team meeting'])
  })

  it('tells a refused login apart, keeps the seal and isolates the other account', async () => {
    const h = setup({
      accounts: [accountWork, accountTeam],
      servers: { 1: () => new Response('', { status: 401 }), 2: team },
      sealed: { 1: SEALED },
    })
    await h.loader.start()
    await settle()
    expect(h.status.errors.value).toEqual({ [externalAccountKey(1)]: 'Login rejected' })
    expect(h.status.passwordFor.value).toEqual({ [externalAccountKey(1)]: 1 })
    expect(h.seals.has(1)).toBe(true)
    expect(h.store.events.value.map((e) => e.title)).toEqual(['Team meeting'])
  })

  it('isolates an account the administrator did not allow, one that is down, and the rate limit', async () => {
    const third = account(3, { name: 'Third', url: 'https://third.example.com/dav/' })
    const fourth = account(4, { name: 'Fourth', url: 'https://fourth.example.com/dav/' })
    const h = setup({
      accounts: [accountTeam, accountWork, third, fourth],
      servers: { 2: team, 1: work },
      sealed: { 1: SEALED },
      onRequest: (call) => {
        if (call.accountId === 3) return ownError.hostNotAllowed()
        if (call.accountId === 4) return ownError.unreachable()
        return undefined
      },
    })
    await h.loader.start()
    await settle()
    expect(h.status.errors.value).toEqual({
      [externalAccountKey(3)]: 'Server not allowed',
      [externalAccountKey(4)]: 'Not reachable',
    })
    expect(h.status.passwordFor.value).toEqual({})
    expect(h.store.events.value.map((e) => e.title).sort()).toEqual([
      'Team meeting',
      'Work meeting',
    ])
  })

  it('reports a rate limit as such', async () => {
    const h = setup({
      accounts: [accountTeam],
      servers: {},
      onRequest: () => ownError.rateLimited(),
    })
    await h.loader.start()
    await settle()
    expect(h.status.errors.value).toEqual({ [externalAccountKey(2)]: 'Too many requests' })
  })

  it('keeps events 30 seconds per calendar and range, and reads again when forced', async () => {
    const h = setup({ accounts: [accountTeam], servers: { 2: team } })
    await h.loader.start()
    await settle()
    const reports = () => h.proxy.calls.filter((c) => c.method === 'REPORT').length
    expect(reports()).toBe(1)
    await h.loader.loadEvents()
    expect(reports()).toBe(1)
    await h.loader.loadEvents({ force: true })
    expect(reports()).toBe(2)
  })

  it('shows an account while another account’s server has not answered yet', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = setup({
      accounts: [accountTeam, accountWork],
      servers: {
        2: team,
        1: async (call) => {
          await gate
          return work(call)
        },
      },
      sealed: { 1: SEALED },
    })
    const started = h.loader.start()
    // Bodies are read from streams, which takes real turns of the event loop.
    await vi.waitFor(() =>
      expect(h.store.events.value.map((e) => e.title)).toEqual(['Team meeting']),
    )
    expect(h.status.loading.value).toBe(true)

    release()
    await started
    await settle()
    expect(h.store.events.value.map((e) => e.title).sort()).toEqual([
      'Team meeting',
      'Work meeting',
    ])
    expect(h.status.loading.value).toBe(false)
  })
})

describe('the source', () => {
  const RANGE = { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-11-02T00:00:00Z') }
  const list = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ url: `${OTHER}/c${index}/`, expand: false }))

  function sourceFor(upstream: Server) {
    const proxy = fakeProxy(upstream)
    const source = createExternalSource({
      fetch: proxy.fetch,
      api: { list: async () => ({ accounts: [], loginsEnabled: true }) },
      seals: createSealStore({ userSub: () => 'sub-1', storage: () => null }),
    })
    return { source, proxy }
  }

  /** Answers every request after a short wait, and remembers the most that ran at once. */
  function counting() {
    const state = { active: 0, max: 0 }
    const server: Server = async () => {
      state.active++
      state.max = Math.max(state.max, state.active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      state.active--
      return multistatus()
    }
    return { state, server }
  }

  it('keeps answers 30 seconds per calendar and range, and starts again for an edited account', async () => {
    const { source, proxy } = sourceFor(() => multistatus())
    const target = account(2, { url: `${OTHER}/` })
    await source.read(target, list(1), RANGE)
    await source.read(target, list(1), RANGE)
    expect(proxy.calls).toHaveLength(1)
    // forced: past the cache
    await source.read(target, list(1), RANGE, { force: true })
    expect(proxy.calls).toHaveLength(2)
    // The account was edited (another address, another time stamp): another reader, no old answers.
    await source.read({ ...target, updatedAt: '2026-10-02T08:00:00.000Z' }, list(1), RANGE)
    expect(proxy.calls).toHaveLength(3)
  })

  it('asks for at most 3 requests of one account at a time', async () => {
    const { state, server } = counting()
    const { source } = sourceFor(server)
    await source.read(account(2, { url: `${OTHER}/` }), list(10), RANGE)
    expect(state.max).toBe(3)
  })

  it('asks for at most 6 requests at a time over all accounts', async () => {
    const { state, server } = counting()
    const { source } = sourceFor(server)
    await Promise.all(
      [1, 2, 3, 4, 5].map((id) => source.read(account(id, { url: `${OTHER}/` }), list(10), RANGE)),
    )
    expect(state.max).toBe(6)
  })

  it('answers every calendar, failed or not, and never rejects, for an address with no origin', async () => {
    const { source } = sourceFor(() => multistatus())
    const results = await source.read(account(2, { url: 'not a url' }), list(2), RANGE)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.error?.kind === 'bad-response')).toBe(true)
  })

  it('forgets the readers of accounts that are gone when the list is read again', async () => {
    const proxy = fakeProxy(() => multistatus())
    const current = { accounts: [account(2, { url: `${OTHER}/` })] }
    const source = createExternalSource({
      fetch: proxy.fetch,
      api: { list: async () => ({ accounts: current.accounts, loginsEnabled: true }) },
      seals: createSealStore({ userSub: () => 'sub-1', storage: () => null }),
    })
    await source.read(current.accounts[0]!, list(1), RANGE)
    current.accounts = []
    await source.listAccounts()
    current.accounts = [account(2, { url: `${OTHER}/` })]
    await source.listAccounts()
    await source.read(current.accounts[0]!, list(1), RANGE)
    expect(proxy.calls).toHaveLength(2)
  })

  it('matches the seal store to the accounts it lists', async () => {
    const seals = createSealStore({ userSub: () => 'sub-1', storage: () => null })
    seals.set(1, 'one', false)
    seals.set(9, 'gone', false)
    const source = createExternalSource({
      fetch: fakeProxy(() => multistatus()).fetch,
      api: { list: async () => ({ accounts: [account(1)], loginsEnabled: true }) },
      seals,
    })
    await source.listAccounts()
    expect(seals.get(1)).toBe('one')
    expect(seals.get(9)).toBeNull()
  })
})
