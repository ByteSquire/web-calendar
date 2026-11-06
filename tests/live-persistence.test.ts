import { describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { createCalendarState, type StateFactory } from '../app/utils/calendar-state'
import { createMockData } from '../app/data/mock'
import { DavError } from '../app/utils/caldav/errors'
import { davFetchFrom } from '../app/utils/live/dav-fetch'
import {
  createKeyedDebouncer,
  createLiveHooks,
  isPersistableRef,
  type Timers,
} from '../app/utils/live/hooks'
import { fetchIcsText, IcsFetchError } from '../app/utils/live/ics'
import { emptySeed, isLiveConfig } from '../app/utils/live/seed'
import type { Calendar } from '../shared/types/calendar'

const anchor = Temporal.PlainDate.from('2026-10-28')

function memoryState(): StateFactory {
  const store = new Map<string, Ref<unknown>>()
  return <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key) as Ref<T>
  }
}

/** Timers that run when the test says so. */
function manualTimers() {
  let next = 1
  const pending = new Map<number, { callback: () => void; ms: number }>()
  const timers: Timers = {
    set: (callback, ms) => {
      pending.set(next, { callback, ms })
      return next++
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  return {
    timers,
    count: () => pending.size,
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire: () => {
      const due = [...pending.values()]
      pending.clear()
      due.forEach((entry) => entry.callback())
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('mode', () => {
  it.each([
    [null, false],
    [undefined, false],
    [{ demo: true, oidc: { issuer: 'https://idm.example.org' } }, false],
    [{ demo: false, oidc: { issuer: '' } }, false],
    [{ demo: false, oidc: {} }, false],
    [{ demo: false, oidc: { issuer: 'https://idm.example.org' } }, true],
  ])('isLiveConfig(%j) = %s', (config, live) => {
    expect(isLiveConfig(config)).toBe(live)
  })

  it('starts empty, with no calendars, events or user', () => {
    const seed = emptySeed()
    expect(seed).toMatchObject({ calendars: [], events: [], views: [], resources: [] })
    expect(seed.currentUser.name).toBe('')
  })
})

describe('createKeyedDebouncer', () => {
  it('sends the last value per key once after the quiet time', async () => {
    const clock = manualTimers()
    const save = vi.fn(async () => {})
    const debouncer = createKeyedDebouncer<boolean>({
      delayMs: 400,
      save,
      onError: vi.fn(),
      timers: clock.timers,
    })
    debouncer.schedule('a', false)
    debouncer.schedule('a', true)
    debouncer.schedule('a', false)
    debouncer.schedule('b', true)
    expect(clock.delays()).toEqual([400, 400])
    expect(debouncer.pending()).toBe(2)
    clock.fire()
    await flush()
    expect(save.mock.calls).toEqual([
      ['a', false],
      ['b', true],
    ])
    expect(debouncer.pending()).toBe(0)
  })

  it('reports a failure once and carries on with the other keys', async () => {
    const clock = manualTimers()
    const onError = vi.fn()
    const debouncer = createKeyedDebouncer<number>({
      delayMs: 1,
      save: async (key) => {
        if (key === 'bad') throw new Error('nope')
      },
      onError,
      timers: clock.timers,
    })
    debouncer.schedule('bad', 1)
    debouncer.schedule('good', 2)
    clock.fire()
    await flush()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error))
  })

  it('flush saves what is pending at once', async () => {
    const clock = manualTimers()
    const save = vi.fn(async () => {})
    const debouncer = createKeyedDebouncer<boolean>({
      delayMs: 400,
      save,
      onError: vi.fn(),
      timers: clock.timers,
    })
    debouncer.schedule('a', true)
    await debouncer.flush()
    expect(save).toHaveBeenCalledWith('a', true)
    expect(clock.count()).toBe(0)
  })
})

describe('the calendar state with hooks', () => {
  function setup(api = vi.fn(async (_path: string, _options?: unknown): Promise<unknown> => ({}))) {
    const clock = manualTimers()
    const notify = vi.fn()
    const hooks = createLiveHooks({
      api: api as never,
      notify,
      timers: clock.timers,
    })
    const store = createCalendarState(memoryState(), {
      seed: () => {
        const seed = createMockData(anchor)
        // Live-like refs for the calendars that persist.
        seed.calendars = [
          ...seed.calendars.slice(0, 2),
          { ...seed.calendars[2]!, id: 'dav:/caldav/u/c/' },
        ]
        return { ...seed, calendars: seed.calendars.map(withRef) }
      },
      today: () => anchor,
      sidebarOpen: () => true,
      hooks,
    })
    return { api, clock, notify, store, hooks }
  }

  const withRef = (calendar: Calendar, index: number): Calendar => ({
    ...calendar,
    id: calendar.id.startsWith('dav:') ? calendar.id : `dav:/caldav/u/${index}/`,
  })

  it('saves a colour, tells who listens, and keeps the old one when the save fails', async () => {
    const saved = { ref: 'dav:/caldav/u/0/', color: '#ffe066', visible: true }
    const api = vi.fn(async (_path: string, _options?: unknown): Promise<unknown> => saved)
    const { store, hooks } = setup(api)
    const heard: unknown[] = []
    const stop = hooks.onPreferenceSaved((pref) => heard.push(pref))
    const calendar = store.calendars.value[0]!
    await store.setCalendarColor(calendar.id, '#ffe066')
    expect(api.mock.calls).toEqual([
      ['/api/calendar-prefs', { method: 'PUT', body: { ref: calendar.id, color: '#ffe066' } }],
    ])
    expect(heard).toEqual([saved])
    expect(store.calendars.value[0]!.color).toBe('#ffe066')
    stop()

    api.mockRejectedValueOnce(new Error('down'))
    await expect(store.setCalendarColor(calendar.id, '#000000')).rejects.toThrow('down')
    expect(store.calendars.value[0]!.color).toBe('#ffe066')
    expect(heard).toHaveLength(1)
  })

  it('saves a toggle as a preference, one request for quick toggles of the same calendar', async () => {
    const { api, clock, store } = setup()
    const id = store.calendars.value[0]!.id
    store.setCalendarVisible(id, false)
    store.setCalendarVisible(id, true)
    store.setCalendarVisible(id, false)
    expect(store.visibleCalendarIds.value).not.toContain(id)
    expect(api).not.toHaveBeenCalled()
    clock.fire()
    await flush()
    expect(api.mock.calls).toEqual([
      ['/api/calendar-prefs', { method: 'PUT', body: { ref: id, visible: false } }],
    ])
  })

  it('remembers the toggle as the calendar’s default so clearing a view restores it', () => {
    const { store } = setup()
    const [first, second] = store.calendars.value
    store.setCalendarVisible(first!.id, false)
    expect(store.calendars.value.find((c) => c.id === first!.id)!.defaultVisible).toBe(false)
    store.selectView(null)
    expect(store.visibleCalendarIds.value).not.toContain(first!.id)
    expect(store.visibleCalendarIds.value).toContain(second!.id)
  })

  it('does not save the visibility a view sets', async () => {
    const { api, clock, store } = setup()
    store.views.value = [
      {
        id: '1',
        name: 'V',
        icon: 'calendar',
        calendarIds: [store.calendars.value[1]!.id],
        isAdmin: false,
      },
    ]
    store.selectView('1')
    store.selectView(null)
    expect(clock.count()).toBe(0)
    expect(api).not.toHaveBeenCalled()
  })

  it('does not save refs the server would refuse', () => {
    expect(isPersistableRef('dav:/caldav/u/c/')).toBe(true)
    expect(isPersistableRef('ics:5')).toBe(true)
    expect(isPersistableRef('ext:1:https://x/')).toBe(true)
    expect(isPersistableRef('cal-personal')).toBe(false)
    expect(isPersistableRef('dav:')).toBe(false)
    expect(isPersistableRef(`dav:${'x'.repeat(600)}`)).toBe(false)
  })

  it('tells about a failed preference save and keeps the toggle', async () => {
    const { clock, notify, store } = setup(vi.fn(async () => Promise.reject({ statusCode: 500 })))
    const id = store.calendars.value[0]!.id
    store.setCalendarVisible(id, false)
    clock.fire()
    await flush()
    expect(notify).toHaveBeenCalledWith(
      'The calendar setting could not be saved: server unavailable.',
    )
    expect(store.visibleCalendarIds.value).not.toContain(id)
  })

  it('adds a category at once and swaps in the server’s id when it is saved', async () => {
    const api = vi.fn(async () => ({ id: 41, name: 'Fun', color: '#123456', shared: false }))
    const { store } = setup(api)
    const added = store.addCategory('Fun')
    expect(added).not.toBeNull()
    store.setCategorySelected(added!.id, true)
    expect(store.categories.value.map((c) => c.id)).toContain(added!.id)
    expect(api.mock.calls[0]).toEqual([
      '/api/categories',
      { method: 'POST', body: { name: 'Fun', color: added!.color } },
    ])
    await flush()
    expect(store.categories.value.find((c) => c.name === 'Fun')).toEqual({
      id: '41',
      name: 'Fun',
      color: '#123456',
    })
    expect(store.selectedCategoryIds.value).toEqual(['41'])
  })

  it('adds the saved category when a reload dropped the local copy meanwhile', async () => {
    const api = vi.fn(async () => ({ id: 41, name: 'Fun', color: '#123456', shared: false }))
    const { store } = setup(api)
    const added = store.addCategory('Fun')!
    store.categories.value = store.categories.value.filter((c) => c.id !== added.id)
    await flush()
    expect(store.categories.value.filter((c) => c.name === 'Fun')).toEqual([
      { id: '41', name: 'Fun', color: '#123456' },
    ])
  })

  it('removes a category the server refused and tells the viewer', async () => {
    const api = vi.fn(async () => Promise.reject({ statusCode: 409 }))
    const { notify, store } = setup(api)
    const before = store.categories.value.length
    const added = store.addCategory('Dup')!
    store.setCategorySelected(added.id, true)
    await flush()
    expect(store.categories.value).toHaveLength(before)
    expect(store.selectedCategoryIds.value).toEqual([])
    expect(notify).toHaveBeenCalledWith(
      'The category "Dup" could not be saved: request refused by the server.',
    )
  })

  it('adds a text filter, activates it, and swaps the id when saved', async () => {
    const api = vi.fn(async () => ({ id: 8, name: 'Offsite x', kind: 'text', value: 'Offsite x' }))
    const { store } = setup(api)
    const filter = store.addFilter('Offsite x')!
    expect(store.activeFilterIds.value).toEqual([filter.id])
    expect(api.mock.calls[0]).toEqual([
      '/api/filters',
      { method: 'POST', body: { name: 'Offsite x', kind: 'text', value: 'Offsite x' } },
    ])
    await flush()
    expect(store.activeFilterIds.value).toEqual(['8'])
    expect(store.filters.value.some((f) => f.id === '8')).toBe(true)
    expect(store.filters.value.some((f) => f.id === filter.id)).toBe(false)
  })

  it('rolls a refused filter back, inactive too', async () => {
    const api = vi.fn(async () => Promise.reject({ statusCode: 400 }))
    const { notify, store } = setup(api)
    const before = store.filters.value.length
    store.addFilter('Too long')
    await flush()
    expect(store.filters.value).toHaveLength(before)
    expect(store.activeFilterIds.value).toEqual([])
    expect(notify).toHaveBeenCalledWith(
      'The filter "Too long" could not be saved: request refused by the server.',
    )
  })

  it('still rejects empty and duplicate names without asking the server', () => {
    const api = vi.fn(async () => ({}))
    const { store } = setup(api)
    expect(store.addCategory('  ')).toBeNull()
    expect(store.addCategory('work')).toBeNull() // "Work" exists in the data
    expect(store.addFilter('')).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('lets the viewer create a category whose name only events carried (auto)', () => {
    const { store } = setup()
    store.categories.value = [
      ...store.categories.value,
      { id: 'auto:holiday', name: 'Holiday', color: '#000000' },
    ].filter((c) => c.id !== 'cat-holiday')
    expect(store.addCategory('holiday')).not.toBeNull()
  })
})

describe('without hooks (demo mode)', () => {
  it('stays purely local', () => {
    const store = createCalendarState(memoryState(), {
      seed: () => createMockData(anchor),
      today: () => anchor,
      sidebarOpen: () => true,
    })
    const first = store.calendars.value[0]!
    store.setCalendarVisible(first.id, false)
    expect(store.calendars.value[0]!.defaultVisible).toBe(first.defaultVisible)
    expect(store.addCategory('Brand new')).not.toBeNull()
  })
})

describe('fetchIcsText', () => {
  const response = (status: number, body: string, type = 'text/calendar') =>
    new Response(body, { status, headers: { 'content-type': type } })

  it('asks the proxy for the subscription and returns the text', async () => {
    const authFetch = vi.fn(async () => response(200, 'BEGIN:VCALENDAR'))
    await expect(fetchIcsText(authFetch as never, '12')).resolves.toBe('BEGIN:VCALENDAR')
    expect(authFetch).toHaveBeenCalledWith('/api/ical-subscriptions/12/data', expect.anything())
  })

  it('encodes the id so it cannot change the path', async () => {
    const authFetch = vi.fn(async (_input: string, _init?: unknown) => response(200, ''))
    await fetchIcsText(authFetch as never, '1/../me')
    expect(authFetch.mock.calls[0]![0]).toBe('/api/ical-subscriptions/1%2F..%2Fme/data')
  })

  it.each([
    ['unreachable', 502],
    ['http-503', 502],
    ['timeout', 502],
  ])('reads the reason %s of a 502', async (reason, status) => {
    const authFetch = vi.fn(async () =>
      response(
        status,
        JSON.stringify({ statusCode: status, data: { reason } }),
        'application/json',
      ),
    )
    await expect(fetchIcsText(authFetch as never, '1')).rejects.toMatchObject({
      name: 'IcsFetchError',
      status,
      reason,
    })
  })

  it('copes with an answer that is not JSON', async () => {
    const authFetch = vi.fn(async () => response(500, '<html>oops</html>', 'text/html'))
    const error = await fetchIcsText(authFetch as never, '1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IcsFetchError)
    expect(error).toMatchObject({ status: 500, reason: null })
  })

  it('lets the login’s failure through', async () => {
    const failure = Object.assign(new Error('Not signed in'), { name: 'AuthRequiredError' })
    const authFetch = vi.fn(async () => Promise.reject(failure))
    await expect(fetchIcsText(authFetch as never, '1')).rejects.toBe(failure)
  })
})

describe('davFetchFrom', () => {
  it('passes responses through', async () => {
    const response = new Response('x')
    const wrapped = davFetchFrom(async () => response)
    await expect(wrapped('/caldav/')).resolves.toBe(response)
  })

  it('turns a failed token renewal into an unauthorized DavError', async () => {
    const failure = Object.assign(new Error('The session could not be renewed'), {
      name: 'AuthRequiredError',
    })
    const wrapped = davFetchFrom(async () => Promise.reject(failure))
    const error = await wrapped('/caldav/').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DavError)
    expect(error).toMatchObject({ kind: 'unauthorized', cause: failure })
  })

  it('leaves other failures to the client, which words them as a network problem', async () => {
    const failure = new TypeError('Failed to fetch')
    const wrapped = davFetchFrom(async () => Promise.reject(failure))
    await expect(wrapped('/caldav/')).rejects.toBe(failure)
  })
})
