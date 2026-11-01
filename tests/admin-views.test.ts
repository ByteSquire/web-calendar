// @vitest-environment nuxt
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarContent, SidebarViewItem, UApp } from '#components'
import { useCalendarState } from '~/composables/useCalendarState'
import {
  createSharedView,
  deleteSharedView,
  describeSharedViewError,
  fetchIsAdmin,
  sharedViewBody,
  updateSharedView,
} from '~/utils/live/admin-views'
import type { CalendarView } from '../shared/types/calendar'

const shared: CalendarView = {
  id: '5',
  name: 'All staff',
  icon: 'shield',
  calendarIds: ['dav:/a/'],
  isAdmin: true,
}

afterEach(() => {
  document.body.innerHTML = ''
  clearNuxtState((key) => key !== 'color-mode')
})

describe('sharedViewBody', () => {
  it('drops ext: refs and repeats', () => {
    expect(
      sharedViewBody('V', 'star', ['dav:/a/', 'ext:x:https://e/c', 'ics:1', 'dav:/a/']),
    ).toEqual({
      name: 'V',
      icon: 'star',
      calendars: [
        { ref: 'dav:/a/', color: null },
        { ref: 'ics:1', color: null },
      ],
    })
  })
})

describe('the requests', () => {
  const view = { id: 7, name: 'N', icon: 'users', calendars: [], isAdmin: true, ownerId: null }

  it('post, put and delete the admin routes', async () => {
    const api = vi.fn(async () => view)
    const body = sharedViewBody('N', 'users', [])
    expect(await createSharedView(api, body)).toMatchObject({ id: '7', isAdmin: true })
    await updateSharedView(api, '7', body)
    await deleteSharedView(api, '7')
    expect(api.mock.calls).toEqual([
      ['/api/admin/views', { method: 'POST', body }],
      ['/api/admin/views/7', { method: 'PUT', body }],
      ['/api/admin/views/7', { method: 'DELETE' }],
    ])
  })

  it('reads the admin flag of /api/me, true only for true', async () => {
    expect(await fetchIsAdmin(async () => ({ isAdmin: true }))).toBe(true)
    expect(await fetchIsAdmin(async () => ({ isAdmin: 'yes' }))).toBe(false)
    expect(await fetchIsAdmin(async () => null)).toBe(false)
  })

  it('words the failures', () => {
    expect(describeSharedViewError({ statusCode: 403 })).toMatch(/administrators/)
    expect(describeSharedViewError({ statusCode: 404 })).toMatch(/no longer exists/)
    expect(describeSharedViewError(new Error('x'))).toMatch(/could not be saved/)
  })
})

describe('SidebarViewItem', () => {
  const actions = () => document.querySelector('[aria-label="Actions for view All staff"]')

  it('gives a shared view no actions to a non-admin', async () => {
    await mountSuspended(SidebarViewItem, {
      props: { view: shared, selected: false },
      attachTo: document.body,
    })
    expect(actions()).toBeNull()
    expect(document.body.textContent).toContain('Shared')
  })

  it('gives an admin the actions of a shared view', async () => {
    await mountSuspended(SidebarViewItem, {
      props: { view: shared, selected: false, canManage: true },
      attachTo: document.body,
    })
    expect(actions()).not.toBeNull()
  })

  it('still gives a user view its (mock) actions', async () => {
    await mountSuspended(SidebarViewItem, {
      props: { view: { ...shared, isAdmin: false, ownerId: 'u' }, selected: false },
      attachTo: document.body,
    })
    expect(document.querySelector('[aria-label="Actions for view All staff"]')).not.toBeNull()
  })
})

describe('SidebarContent without a server (mock data)', () => {
  const Shell = defineComponent({
    render: () => h(UApp, null, { default: () => h(SidebarContent) }),
  })

  it('offers to create a shared view from the selection', async () => {
    await mountSuspended(Shell, { attachTo: document.body })
    const { views, visibleCalendarIds } = useCalendarState()
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Add shared view"]')
    expect(input).not.toBeNull()
    input!.value = 'Ops'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('button[aria-label="Add shared view"]')!.click()
    await vi.waitFor(() => expect(views.value.some((view) => view.name === 'Ops')).toBe(true))
    const created = views.value.find((view) => view.name === 'Ops')!
    expect(created.isAdmin).toBe(true)
    expect(created.calendarIds).toEqual(visibleCalendarIds.value)
  })
})
