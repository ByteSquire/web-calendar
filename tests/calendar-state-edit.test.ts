// The calendar state's editing functions: renaming, recolouring and deleting categories, filters
// and calendars, with and without a backend hook, and the ids that are still being saved.
import { describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { emptySeed } from '../app/utils/live/seed'
import {
  createCalendarState,
  type CalendarStateHooks,
  type StateFactory,
} from '../app/utils/calendar-state'
import type { Calendar, CalendarEvent, CalendarFilter, Category } from '../shared/types/calendar'

function memoryState(): StateFactory {
  const store = new Map<string, Ref<unknown>>()
  return <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key) as Ref<T>
  }
}

const cat = (id: string, name: string, extra: Partial<Category> = {}): Category => ({
  id,
  name,
  color: '#112233',
  ...extra,
})

const filter = (id: string, name: string, kind: CalendarFilter['kind'], value = name) => ({
  id,
  name,
  kind,
  value,
})

const calendar = (id: string, extra: Partial<Calendar> = {}): Calendar => ({
  id,
  name: id,
  color: '#abcdef',
  ownColor: '#abcdef',
  defaultVisible: true,
  type: 'caldav',
  readOnly: false,
  ...extra,
})

const event = (id: string, calendarId: string): CalendarEvent => ({
  id,
  uid: id,
  calendarId,
  title: id,
  start: '2026-10-28T10:00:00',
  end: '2026-10-28T11:00:00',
  allDay: false,
  status: 'confirmed',
  categoryIds: [],
})

function setup(hooks?: CalendarStateHooks) {
  return createCalendarState(memoryState(), {
    seed: () => ({
      ...emptySeed(),
      calendars: [
        calendar('own', { manage: { kind: 'own' } }),
        calendar('grp', { manage: { kind: 'group', groupId: 3, calendarId: 7 } }),
        calendar('plain'),
        calendar('default', { manage: { kind: 'own', default: true } }),
      ],
      categories: [
        cat('1', 'Work'),
        cat('2', 'Home'),
        cat('auto:travel', 'Travel'),
        cat('auto:sport', 'Sport'),
      ],
      filters: [
        filter('f1', 'lunch', 'text'),
        filter('f2', 'Meetings', 'category', 'cat-1'),
        filter('f3', 'Tentative', 'status', 'tentative'),
      ],
      events: [event('e1', 'own'), event('e2', 'own'), event('e3', 'plain')],
    }),
    today: () => Temporal.PlainDate.from('2026-10-28'),
    sidebarOpen: () => true,
    ...(hooks ? { hooks } : {}),
  })
}

const byId = <T extends { id: string }>(items: T[], id: string) => items.find((i) => i.id === id)

describe('updateCategory', () => {
  it('renames and recolours', async () => {
    const store = setup()
    expect(await store.updateCategory('1', { name: '  Job ', color: '#ff0000' })).toBe(true)
    expect(byId(store.categories.value, '1')).toMatchObject({ name: 'Job', color: '#ff0000' })
    expect(await store.updateCategory('1', { color: '#00ff00' })).toBe(true)
    expect(byId(store.categories.value, '1')).toMatchObject({ name: 'Job', color: '#00ff00' })
  })

  it('refuses an empty name and a taken one, ignoring case', async () => {
    const store = setup()
    expect(await store.updateCategory('1', { name: '   ' })).toBe(false)
    expect(await store.updateCategory('1', { name: 'hOmE' })).toBe(false)
    expect(byId(store.categories.value, '1')!.name).toBe('Work')
  })

  it('allows the name of an auto category and a change of letter case of its own name', async () => {
    const store = setup()
    expect(await store.updateCategory('1', { name: 'travel' })).toBe(true)
    expect(await store.updateCategory('1', { name: 'TRAVEL' })).toBe(true)
    expect(byId(store.categories.value, '1')!.name).toBe('TRAVEL')
  })

  it('never changes an auto category, nor an unknown one', async () => {
    const store = setup()
    expect(await store.updateCategory('auto:travel', { name: 'Trip' })).toBe(false)
    expect(await store.updateCategory('nope', { name: 'Trip' })).toBe(false)
    expect(byId(store.categories.value, 'auto:travel')!.name).toBe('Travel')
  })

  it('uses the category the hook returns', async () => {
    const saveCategory = vi.fn(async (c: Category) => ({ ...c, id: '1', color: '#999999' }))
    const store = setup({ saveCategory })
    await store.updateCategory('1', { name: 'Job' })
    expect(saveCategory).toHaveBeenCalledWith(expect.objectContaining({ id: '1', name: 'Job' }))
    expect(byId(store.categories.value, '1')).toMatchObject({ name: 'Job', color: '#999999' })
  })

  it('rejects and keeps the state when the hook rejects', async () => {
    const store = setup({ saveCategory: vi.fn().mockRejectedValue(new Error('down')) })
    await expect(store.updateCategory('1', { name: 'Job' })).rejects.toThrow('down')
    expect(byId(store.categories.value, '1')).toMatchObject({ name: 'Work', color: '#112233' })
  })

  it('does not call the hook for a refused change', async () => {
    const saveCategory = vi.fn(async (c: Category) => c)
    const store = setup({ saveCategory })
    await store.updateCategory('1', { name: 'Home' })
    expect(saveCategory).not.toHaveBeenCalled()
  })
})

describe('deleteCategory', () => {
  it('removes the category and its selection', async () => {
    const store = setup()
    store.setCategorySelected('1', true)
    await store.deleteCategory('1')
    expect(byId(store.categories.value, '1')).toBeUndefined()
    expect(store.selectedCategoryIds.value).not.toContain('1')
  })

  it('leaves auto categories alone', async () => {
    const store = setup()
    await store.deleteCategory('auto:travel')
    expect(byId(store.categories.value, 'auto:travel')).toBeDefined()
  })

  it('asks the hook first, and keeps everything when it rejects', async () => {
    const calls: string[] = []
    const removeCategory = vi.fn(async (c: Category) => {
      calls.push(`hook ${c.id} still listed: ${byId(store.categories.value, c.id) !== undefined}`)
    })
    const store = setup({ removeCategory })
    await store.deleteCategory('2')
    expect(calls).toEqual(['hook 2 still listed: true'])
    expect(byId(store.categories.value, '2')).toBeUndefined()

    const failing = setup({ removeCategory: vi.fn().mockRejectedValue(new Error('no')) })
    failing.setCategorySelected('1', true)
    await expect(failing.deleteCategory('1')).rejects.toThrow('no')
    expect(byId(failing.categories.value, '1')).toBeDefined()
    expect(failing.selectedCategoryIds.value).toContain('1')
  })
})

describe('updateFilter', () => {
  it('changes name and value of a text filter', async () => {
    const store = setup()
    expect(await store.updateFilter('f1', ' dinner ')).toBe(true)
    expect(byId(store.filters.value, 'f1')).toMatchObject({ name: 'dinner', value: 'dinner' })
  })

  it('changes only the name of a category or status filter', async () => {
    const store = setup()
    await store.updateFilter('f2', 'Team')
    await store.updateFilter('f3', 'Maybe')
    expect(byId(store.filters.value, 'f2')).toMatchObject({ name: 'Team', value: 'cat-1' })
    expect(byId(store.filters.value, 'f3')).toMatchObject({ name: 'Maybe', value: 'tentative' })
  })

  it('refuses empty and taken names, ignoring case', async () => {
    const store = setup()
    expect(await store.updateFilter('f1', ' ')).toBe(false)
    expect(await store.updateFilter('f1', 'MEETINGS')).toBe(false)
    expect(await store.updateFilter('nope', 'x')).toBe(false)
    expect(byId(store.filters.value, 'f1')!.name).toBe('lunch')
  })

  it('uses what the hook returns and keeps the state when it rejects', async () => {
    const saveFilter = vi.fn(async (f: CalendarFilter) => ({ ...f, value: 'from server' }))
    const store = setup({ saveFilter })
    await store.updateFilter('f1', 'dinner')
    expect(byId(store.filters.value, 'f1')).toMatchObject({ name: 'dinner', value: 'from server' })

    const failing = setup({ saveFilter: vi.fn().mockRejectedValue(new Error('down')) })
    await expect(failing.updateFilter('f1', 'dinner')).rejects.toThrow('down')
    expect(byId(failing.filters.value, 'f1')!.name).toBe('lunch')
  })
})

describe('deleteFilter', () => {
  it('removes the filter and deactivates it', async () => {
    const store = setup()
    store.setFilterActive('f1', true)
    await store.deleteFilter('f1')
    expect(byId(store.filters.value, 'f1')).toBeUndefined()
    expect(store.activeFilterIds.value).not.toContain('f1')
  })

  it('keeps the filter when the hook rejects', async () => {
    const removeFilter = vi.fn().mockRejectedValue(new Error('no'))
    const store = setup({ removeFilter })
    store.setFilterActive('f1', true)
    await expect(store.deleteFilter('f1')).rejects.toThrow('no')
    expect(removeFilter).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }))
    expect(byId(store.filters.value, 'f1')).toBeDefined()
    expect(store.activeFilterIds.value).toContain('f1')
  })
})

describe('renameCalendar and deleteCalendar', () => {
  it('rename calls the hook with the calendar and the name, then shows it', async () => {
    const renameCalendar = vi.fn(async () => {})
    const store = setup({ renameCalendar })
    await store.renameCalendar('own', 'Mine')
    expect(renameCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: 'own' }), 'Mine')
    expect(byId(store.calendars.value, 'own')!.name).toBe('Mine')
  })

  it('does nothing for a calendar the viewer may not manage', async () => {
    const renameCalendar = vi.fn(async () => {})
    const removeCalendar = vi.fn(async () => {})
    const store = setup({ renameCalendar, removeCalendar })
    await store.renameCalendar('plain', 'X')
    await store.deleteCalendar('plain')
    await store.deleteCalendar('missing')
    expect(renameCalendar).not.toHaveBeenCalled()
    expect(removeCalendar).not.toHaveBeenCalled()
    expect(byId(store.calendars.value, 'plain')!.name).toBe('plain')
    expect(store.events.value.some((e) => e.calendarId === 'plain')).toBe(true)
  })

  it('delete removes the calendar, its visibility and its events', async () => {
    const removeCalendar = vi.fn(async () => {})
    const store = setup({ removeCalendar })
    expect(store.visibleCalendarIds.value).toContain('own')
    await store.deleteCalendar('own')
    expect(removeCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: 'own' }))
    expect(byId(store.calendars.value, 'own')).toBeUndefined()
    expect(store.visibleCalendarIds.value).not.toContain('own')
    expect(store.events.value.map((e) => e.id)).toEqual(['e3'])
  })

  it('renames the default calendar, and never deletes it', async () => {
    const renameCalendar = vi.fn(async () => {})
    const removeCalendar = vi.fn(async () => {})
    const store = setup({ renameCalendar, removeCalendar })
    await store.renameCalendar('default', 'Jane Doe')
    expect(byId(store.calendars.value, 'default')!.name).toBe('Jane Doe')
    await store.deleteCalendar('default')
    expect(removeCalendar).not.toHaveBeenCalled()
    expect(byId(store.calendars.value, 'default')).toBeDefined()
  })

  it('a rejecting hook leaves the state and rejects', async () => {
    const store = setup({
      renameCalendar: vi.fn().mockRejectedValue(new Error('a')),
      removeCalendar: vi.fn().mockRejectedValue(new Error('b')),
    })
    await expect(store.renameCalendar('grp', 'X')).rejects.toThrow('a')
    await expect(store.deleteCalendar('grp')).rejects.toThrow('b')
    expect(byId(store.calendars.value, 'grp')!.name).toBe('grp')
    expect(store.visibleCalendarIds.value).toContain('grp')
  })
})

describe('savingIds', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('holds a new category while it is saved, until it resolves', async () => {
    const pending = deferred<Category>()
    const store = setup({ persistCategory: () => pending.promise })
    const created = store.addCategory('Fresh')!
    expect(store.savingIds.value).toEqual([created.id])
    pending.resolve({ ...created, id: '99' })
    await tick()
    expect(store.savingIds.value).toEqual([])
    expect(byId(store.categories.value, '99')).toBeDefined()
  })

  it('releases a category when the save fails', async () => {
    const pending = deferred<Category>()
    const store = setup({ persistCategory: () => pending.promise, onPersistError: vi.fn() })
    const created = store.addCategory('Fresh')!
    expect(store.savingIds.value).toContain(created.id)
    pending.reject(new Error('down'))
    await tick()
    expect(store.savingIds.value).toEqual([])
    expect(byId(store.categories.value, created.id)).toBeUndefined()
  })

  it('holds a new filter until it resolves or rejects', async () => {
    const ok = deferred<CalendarFilter>()
    const store = setup({ persistFilter: () => ok.promise })
    const created = store.addFilter('brunch')!
    expect(store.savingIds.value).toEqual([created.id])
    ok.resolve({ ...created, id: '55' })
    await tick()
    expect(store.savingIds.value).toEqual([])

    const bad = deferred<CalendarFilter>()
    const other = setup({ persistFilter: () => bad.promise, onPersistError: vi.fn() })
    const failed = other.addFilter('brunch')!
    expect(other.savingIds.value).toEqual([failed.id])
    bad.reject(new Error('down'))
    await tick()
    expect(other.savingIds.value).toEqual([])
  })

  it('is empty without a backend', () => {
    const store = setup()
    store.addCategory('Fresh')
    store.addFilter('brunch')
    expect(store.savingIds.value).toEqual([])
  })
})
