// @vitest-environment nuxt
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarContent, UApp } from '#components'
import { useCalendarState } from '~/composables/useCalendarState'
import {
  VIEW_NAME_MAX,
  copyName,
  createOwnView,
  deleteOwnView,
  describeOwnViewError,
  ownViewBody,
  updateOwnView,
} from '~/utils/live/user-views'

// A user's own views (FR-2, FR-21): the requests of /api/views and the sidebar without a server.

describe('ownViewBody', () => {
  it('keeps ext: refs, which own views may hold, and drops repeats', () => {
    expect(ownViewBody('V', 'star', ['dav:/a/', 'ext:1:https://e/c', 'dav:/a/'])).toEqual({
      name: 'V',
      icon: 'star',
      calendars: [
        { ref: 'dav:/a/', color: null },
        { ref: 'ext:1:https://e/c', color: null },
      ],
    })
  })
})

describe('copyName', () => {
  it('adds (copy), then (copy 2) and on while the name is taken', () => {
    expect(copyName('Team', [])).toBe('Team (copy)')
    expect(copyName('Team', ['Team (copy)'])).toBe('Team (copy 2)')
    expect(copyName('Team', ['Team (copy)', 'Team (copy 2)'])).toBe('Team (copy 3)')
    expect(copyName('Team', ['Other'])).toBe('Team (copy)')
  })

  it('stays within the length the server accepts', () => {
    const long = 'x'.repeat(VIEW_NAME_MAX)
    const copy = copyName(long, [])
    expect(copy.length).toBeLessThanOrEqual(VIEW_NAME_MAX)
    expect(copy.endsWith(' (copy)')).toBe(true)
    expect(copyName(long, [copy]).length).toBeLessThanOrEqual(VIEW_NAME_MAX)
  })
})

describe('the requests', () => {
  const view = { id: 7, name: 'N', icon: 'star', calendars: [], isAdmin: false, ownerId: 3 }

  it('post, put and delete /api/views, not the admin routes', async () => {
    const api = vi.fn(async () => view)
    const body = ownViewBody('N', 'star', [])
    expect(await createOwnView(api, body)).toMatchObject({ id: '7', isAdmin: false })
    await updateOwnView(api, '7', body)
    await deleteOwnView(api, '7')
    expect(api.mock.calls).toEqual([
      ['/api/views', { method: 'POST', body }],
      ['/api/views/7', { method: 'PUT', body }],
      ['/api/views/7', { method: 'DELETE' }],
    ])
  })

  it('words the failures', () => {
    expect(describeOwnViewError({ statusCode: 404 })).toMatch(/no longer exists/)
    expect(describeOwnViewError({ statusCode: 409 })).toMatch(/too many views/)
    expect(describeOwnViewError({ status: 429 })).toMatch(/Too many changes/)
    expect(describeOwnViewError({ statusCode: 400 })).toMatch(/did not accept/)
    expect(describeOwnViewError(new Error('x'))).toMatch(/could not be saved/)
  })
})

describe('SidebarContent without a server (mock data)', () => {
  const mounted: { unmount: () => void }[] = []
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    clearNuxtState((key) => key !== 'color-mode')
  })

  const Shell = defineComponent({
    render: () => h(UApp, null, { default: () => h(SidebarContent) }),
  })

  async function addView(name: string) {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Add view"]')
    expect(input).not.toBeNull()
    input!.value = name
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('button[aria-label="Add view"]')!.click()
  }

  it("adds a view of the user's own from the selection, not a shared one", async () => {
    mounted.push(await mountSuspended(Shell, { attachTo: document.body }))
    const { views, visibleCalendarIds } = useCalendarState()
    await addView('Mine')
    await vi.waitFor(() => expect(views.value.some((view) => view.name === 'Mine')).toBe(true))
    const created = views.value.find((view) => view.name === 'Mine')!
    expect(created.isAdmin).toBe(false)
    expect(created.calendarIds).toEqual(visibleCalendarIds.value)
  })

  it('refuses a second own view with the same name, and says so', async () => {
    mounted.push(await mountSuspended(Shell, { attachTo: document.body }))
    const { views } = useCalendarState()
    await addView('Mine')
    await vi.waitFor(() => expect(views.value.some((view) => view.name === 'Mine')).toBe(true))
    const before = views.value.length
    await addView('Mine')
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('A view with this name already exists.'),
    )
    expect(views.value).toHaveLength(before)
  })
})
