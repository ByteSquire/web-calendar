// The live hooks that save edits: renaming, recolouring and deleting categories, filters and
// calendars. Checks which API route each one calls, and with what body or query.
import { describe, expect, it, vi } from 'vitest'
import { createLiveHooks } from '../app/utils/live/hooks'
import type { Calendar, CalendarFilter, Category } from '../shared/types/calendar'

function setup(responses: Record<string, unknown> = {}, extra: object = {}) {
  const api = vi.fn(async (path: string, _options?: unknown): Promise<unknown> => responses[path])
  const hooks = createLiveHooks({ api: api as never, notify: vi.fn(), ...extra })
  return { api, hooks }
}

const category = (id: string, extra: Partial<Category> = {}): Category => ({
  id,
  name: 'Work',
  color: '#112233',
  ...extra,
})

const calendar = (extra: Partial<Calendar>): Calendar => ({
  id: 'dav:/caldav/u/c/',
  name: 'C',
  color: '#abcdef',
  ownColor: '#abcdef',
  defaultVisible: true,
  type: 'caldav',
  readOnly: false,
  href: '/caldav/u/c/',
  ...extra,
})

describe('categories', () => {
  it('saves an own category to /api/categories/<id> and returns the stored one', async () => {
    const { api, hooks } = setup({
      '/api/categories/5': { id: 5, name: 'Job', color: '#00ff00' },
    })
    const saved = await hooks.saveCategory!(category('5', { name: 'Job', color: '#00ff00' }))
    expect(api).toHaveBeenCalledWith('/api/categories/5', {
      method: 'PUT',
      body: { name: 'Job', color: '#00ff00' },
    })
    expect(saved).toEqual({ id: '5', name: 'Job', color: '#00ff00' })
  })

  it('saves a shared category through the admin route', async () => {
    const { api, hooks } = setup({
      '/api/admin/categories/6': { id: 6, name: 'Work', color: '#112233', shared: true },
    })
    const saved = await hooks.saveCategory!(category('6', { shared: true }))
    expect(api).toHaveBeenCalledWith('/api/admin/categories/6', {
      method: 'PUT',
      body: { name: 'Work', color: '#112233' },
    })
    expect(saved.shared).toBe(true)
  })

  it('deletes on the same routes', async () => {
    const { api, hooks } = setup()
    await hooks.removeCategory!(category('5'))
    await hooks.removeCategory!(category('6', { shared: true }))
    expect(api.mock.calls).toEqual([
      ['/api/categories/5', { method: 'DELETE' }],
      ['/api/admin/categories/6', { method: 'DELETE' }],
    ])
  })

  it('lets an error of the server through', async () => {
    const { api, hooks } = setup()
    api.mockRejectedValueOnce(new Error('403'))
    await expect(hooks.removeCategory!(category('5'))).rejects.toThrow('403')
  })
})

describe('filters', () => {
  const filter: CalendarFilter = { id: '8', name: 'lunch', kind: 'text', value: 'lunch' }

  it('saves to /api/filters/<id> and returns the stored filter', async () => {
    const { api, hooks } = setup({
      '/api/filters/8': { id: 8, name: 'lunch', kind: 'text', value: 'lunch' },
    })
    const saved = await hooks.saveFilter!(filter)
    expect(api).toHaveBeenCalledWith('/api/filters/8', {
      method: 'PUT',
      body: { name: 'lunch', kind: 'text', value: 'lunch' },
    })
    expect(saved).toEqual(filter)
  })

  it('deletes it', async () => {
    const { api, hooks } = setup()
    await hooks.removeFilter!(filter)
    expect(api).toHaveBeenCalledWith('/api/filters/8', { method: 'DELETE' })
  })
})

describe('calendars', () => {
  const group = calendar({ manage: { kind: 'group', groupId: 3, calendarId: 7 } })
  const own = calendar({ manage: { kind: 'own' } })

  it('renames a group calendar through the group route', async () => {
    const { api, hooks } = setup()
    await hooks.renameCalendar!(group, 'New')
    expect(api).toHaveBeenCalledWith('/api/groups/3/calendars/7', {
      method: 'PATCH',
      body: { name: 'New' },
    })
  })

  it('renames an own calendar through renameOwnCalendar', async () => {
    const renameOwnCalendar = vi.fn(async () => {})
    const { api, hooks } = setup({}, { renameOwnCalendar })
    await hooks.renameCalendar!(own, 'New')
    expect(renameOwnCalendar).toHaveBeenCalledWith('/caldav/u/c/', 'New')
    expect(api).not.toHaveBeenCalled()
  })

  it('deletes a group calendar through the group route', async () => {
    const { api, hooks } = setup()
    await hooks.removeCalendar!(group)
    expect(api.mock.calls).toEqual([['/api/groups/3/calendars/7', { method: 'DELETE' }]])
  })

  it('deletes an own calendar, then its preference', async () => {
    const { api, hooks } = setup()
    await hooks.removeCalendar!(own)
    expect(api.mock.calls).toEqual([
      ['/api/me/calendars', { method: 'DELETE', query: { href: '/caldav/u/c/' } }],
      ['/api/calendar-prefs', { method: 'DELETE', query: { ref: 'dav:/caldav/u/c/' } }],
    ])
  })

  it('does not fail when the preference cannot be deleted', async () => {
    const { api, hooks } = setup()
    api.mockImplementation(async (path: string) => {
      if (path === '/api/calendar-prefs') throw new Error('gone')
      return undefined
    })
    await expect(hooks.removeCalendar!(own)).resolves.toBeUndefined()
  })

  it('fails, and leaves the preference, when the calendar cannot be deleted', async () => {
    const { api, hooks } = setup()
    api.mockRejectedValueOnce(new Error('403'))
    await expect(hooks.removeCalendar!(own)).rejects.toThrow('403')
    expect(api).toHaveBeenCalledTimes(1)
  })
})
