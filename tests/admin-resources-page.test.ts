// @vitest-environment nuxt
// The resources administration page inside a real Nuxt UI app, with a fake API behind
// `useAuthFetch`: who is sent away, what is listed, what add (in its dialog), edit, deactivate (in
// the dialog of a resource) and the rules send, and how the server's messages are shown: a toast,
// and a failure in place as well.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp, USelect, USelectMenu } from '#components'
import ResourcesPage from '~/pages/admin/resources.vue'
import type { AdminResource, ResourceRule } from '~/utils/admin/resources'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler, refresh: vi.fn() }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))
vi.mock('~/composables/useLiveCalendar', () => ({
  useLiveStatus: () => ({ refresh: api.refresh }),
}))
// What the page and the dialogs toast.
const notes = vi.hoisted(() => ({ done: vi.fn(), failed: vi.fn() }))
vi.mock('~/composables/useNotify', () => ({ useNotify: () => notes }))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(ResourcesPage) }) })

const ME = { id: 1, sub: 's', username: 'alice', name: 'Alice', email: null, timeZone: null }
const BOB = '11111111-1111-4111-8111-111111111111'
const start = (): AdminResource[] => [
  {
    id: 1,
    name: 'Board room',
    type: 'room',
    location: 'Floor 2',
    capacity: 12,
    description: null,
    active: true,
  },
  {
    id: 2,
    name: 'Old van',
    type: 'car',
    location: null,
    capacity: null,
    description: null,
    active: false,
  },
]

const calls: { path: string; method: string; body: unknown }[] = []
let admin = true
let failure: unknown = null
let resources: AdminResource[]
let rules: ResourceRule[]
let app: Awaited<ReturnType<typeof mountSuspended>>
let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  calls.length = 0
  admin = true
  failure = null
  resources = start()
  rules = [
    { principalType: 'user', principal: BOB, right: 'manage' },
    { principalType: 'authenticated', principal: null, right: 'book' },
  ]
  api.refresh.mockReset()
  notes.done.mockReset()
  notes.failed.mockReset()
  replace = vi.fn(async () => undefined)
  vi.spyOn(useRouter(), 'replace').mockImplementation(replace as never)
  api.handler = async (path, options) => {
    const method = options?.method ?? 'GET'
    calls.push({ path, method, body: options?.body })
    if (path === '/api/me') {
      // mountSuspended navigates to '/' itself; only a call after this answer comes from the page.
      replace.mockClear()
      return { ...ME, isAdmin: admin }
    }
    if (path === '/api/groups') return { groups: [{ name: 'staff' }] }
    if (path === '/api/admin/access/users')
      return { users: [{ sub: BOB, name: 'Bob Builder', username: 'bob' }] }
    if (path === '/api/admin/resources' && method === 'GET') return { resources }
    if (method !== 'GET' && failure) throw failure
    if (path === '/api/admin/resources' && method === 'POST') {
      const made = { id: 3, active: true, ...(options?.body as object) } as AdminResource
      resources = [...resources, made]
      return made
    }
    const match = /^\/api\/admin\/resources\/(\d+)(\/.*)?$/.exec(path)
    const found = resources.find((item) => item.id === Number(match?.[1]))
    if (match && found) {
      if (match[2] === '/acl') {
        if (method === 'PUT') rules = (options?.body as { rules: ResourceRule[] }).rules
        return { rules }
      }
      if (match[2] === '/deactivate') return { ...found, active: false }
      if (method === 'PUT') return { ...found, ...(options?.body as object) }
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
})

afterEach(() => {
  app.unmount()
  api.handler = null
  clearNuxtState()
  vi.restoreAllMocks()
})

async function mountPage() {
  app = await mountSuspended(Shell, { attachTo: document.body })
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const rows = () => [...document.querySelectorAll('[data-resource]')].map((li) => text(li))
const ruleRows = () => [...document.querySelectorAll('[data-resource-rule]')].map((li) => text(li))
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''),
  )
// The dialog that is open: its fields are the ones meant.
const dialogEl = () => document.querySelector('[role="dialog"]')
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...(dialogEl() ?? document).querySelectorAll('label')].find((item) =>
    text(item)?.startsWith(label),
  )
  return document.getElementById(found?.getAttribute('for') ?? '') as HTMLInputElement
}
function fill(label: string, value: string) {
  const input = field(label)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const sent = (method: string) => calls.filter((call) => call.method === method)
const formButton = (name: RegExp, heading: string) =>
  [...(dialogEl() ?? document).querySelectorAll('form')]
    .find((form) => text(form.querySelector('h2')) === heading)
    ?.querySelectorAll('button')
    .values()
    .find((item) => name.test(item.textContent ?? ''))
async function loaded() {
  await vi.waitFor(() => expect(rows()).toHaveLength(2))
}
async function openNew() {
  button(/^New resource$/)!.click()
  await vi.waitFor(() => expect(formButton(/Add resource/, 'Add resource')).toBeDefined())
}
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
const selected = () => tabs().find((item) => item.getAttribute('aria-selected') === 'true')

describe('who sees the page', () => {
  it('sends a user who is not an admin back to the calendar without asking for resources', async () => {
    admin = false
    await mountPage()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(calls.map((call) => call.path)).toEqual(['/api/me'])
    expect(rows()).toHaveLength(0)
  })
})

describe('as an admin', () => {
  it('lists active and inactive resources', async () => {
    await mountPage()
    await loaded()
    expect(document.querySelector('h1')?.textContent).toBe('Resources')
    expect(rows()[0]).toContain('Board room')
    expect(rows()[0]).toContain('Room · Floor 2 · 12 places')
    expect(rows()[1]).toContain('Old van')
    expect(rows()[1]).toContain('Inactive')
    // a row has Edit and Access; the rest is in the dialog
    const buttons = [...document.querySelectorAll('[data-resource]')].map((row) =>
      [...row.querySelectorAll('button')].map((item) => item.getAttribute('aria-label')),
    )
    expect(buttons).toEqual([
      ['Edit Board room', 'Access for Board room'],
      ['Edit Old van', 'Access for Old van'],
    ])
    // and no form below the list: "New resource" opens one
    expect(document.querySelector('form')).toBeNull()
    expect(button(/^New resource$/)?.disabled).toBe(false)
  })

  it('adds a resource in a dialog: sends the trimmed fields, lists it, opens it on its access', async () => {
    await mountPage()
    await loaded()
    await openNew()
    expect(text(dialogEl()!.querySelector('h2'))).toBe('New resource')
    fill('Name', '  Projector ')
    fill('Capacity', '4')
    fill('Description', 'Portable')
    await vi.waitFor(() => expect(field('Name').value).toBe('  Projector '))
    formButton(/Add resource/, 'Add resource')!.click()
    await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
    expect(sent('POST')[0]).toMatchObject({
      path: '/api/admin/resources',
      body: {
        name: 'Projector',
        type: 'room',
        location: null,
        capacity: 4,
        description: 'Portable',
      },
    })
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    expect(notes.done.mock.calls).toEqual([
      ['Projector was added. Everyone signed in can book it; choose who manages it.'],
    ])
    expect(api.refresh).toHaveBeenCalledWith({ external: false })
    // who manages it comes next: its dialog opens on Access
    await vi.waitFor(() => expect(text(dialogEl()?.querySelector('h2'))).toBe('Projector'))
    expect(text(selected())).toBe('Access')
    await vi.waitFor(() => expect(ruleRows()).toHaveLength(2))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('puts focus in the name of a new resource, and back on "New resource" after Cancel or Escape', async () => {
    await mountPage()
    await loaded()
    for (const leave of ['Cancel', 'Escape']) {
      button(/^New resource$/)!.focus()
      await openNew()
      await vi.waitFor(() => expect(document.activeElement).toBe(field('Name')))
      if (leave === 'Cancel') button(/^Cancel$/)!.click()
      else
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      await vi.waitFor(() => expect(dialogEl()).toBeNull())
      await vi.waitFor(() => expect(document.activeElement).toBe(button(/^New resource$/)))
    }
  })

  it('after a new resource, gives focus to its Edit button when its dialog closes', async () => {
    await mountPage()
    await loaded()
    button(/^New resource$/)!.focus()
    await openNew()
    fill('Name', 'Projector')
    formButton(/Add resource/, 'Add resource')!.focus()
    formButton(/Add resource/, 'Add resource')!.click()
    await vi.waitFor(() => expect(text(dialogEl()?.querySelector('h2'))).toBe('Projector'))
    // the new resource's dialog keeps the focus: it is not sent back behind it
    await vi.waitFor(() => expect(dialogEl()!.contains(document.activeElement)).toBe(true))
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(button(/^Edit Projector$/)))
  })

  it('does not send an empty name or a capacity that is not a number', async () => {
    await mountPage()
    await loaded()
    await openNew()
    formButton(/Add resource/, 'Add resource')!.click()
    await vi.waitFor(() => expect(text(document.body)).toContain('Enter a name.'))
    fill('Name', 'X')
    fill('Capacity', 'many')
    formButton(/Add resource/, 'Add resource')!.click()
    await vi.waitFor(() => expect(text(document.body)).toContain('Enter a whole number'))
    expect(sent('POST')).toHaveLength(0)
  })

  it('shows the field messages of the server and keeps the dialog open', async () => {
    failure = {
      statusCode: 400,
      data: {
        statusCode: 400,
        message: 'The request is not valid',
        data: {
          fields: [{ field: 'capacity', message: 'must be a whole number from 1 to 100000' }],
        },
      },
    }
    await mountPage()
    await loaded()
    await openNew()
    fill('Name', 'Hall')
    fill('Capacity', '0')
    formButton(/Add resource/, 'Add resource')!.click()
    await vi.waitFor(() =>
      expect(text(document.body)).toContain('must be a whole number from 1 to 100000'),
    )
    expect(text(document.querySelector('form [id$="-error"]'))).toContain(
      'must be a whole number from 1 to 100000',
    )
    // the reason in the dialog, and in a toast
    expect(text(dialogEl()!.querySelector('[role="alert"]'))).toContain('Nothing was changed.')
    expect(notes.failed.mock.calls).toEqual([[expect.stringContaining('Nothing was changed.')]])
    expect(notes.done).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(2)
    expect(field('Name').value).toBe('Hall')

    // opened again, it starts clean
    button(/^Cancel$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    await openNew()
    expect(dialogEl()!.querySelector('[role="alert"]')).toBeNull()
    expect(dialogEl()!.querySelector('[id$="-error"]')).toBeNull()
    expect(field('Name').value).toBe('')
  })

  it('says it plainly when the server cannot be reached', async () => {
    failure = new TypeError('Failed to fetch')
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(button(/^Deactivate Board room$/)).toBeDefined())
    button(/^Deactivate Board room$/)!.click()
    await vi.waitFor(() =>
      expect(text(dialogEl()!.querySelector('[role="alert"]'))).toContain('could not be reached'),
    )
    expect(notes.failed).toHaveBeenCalledWith(expect.stringContaining('could not be reached'))
  })

  it('edits a resource: the form starts with its values and a save sends all fields', async () => {
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(formButton(/Save changes/, 'Edit resource')).toBeDefined())
    expect(field('Name').value).toBe('Board room')
    expect(field('Capacity').value).toBe('12')
    fill('Name', 'Large room')
    fill('Capacity', '')
    formButton(/Save changes/, 'Edit resource')!.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]).toMatchObject({
      path: '/api/admin/resources/1',
      body: { name: 'Large room', type: 'room', location: 'Floor 2', capacity: null },
    })
    await vi.waitFor(() => expect(rows()[0]).toContain('Large room'))
    // As the dialog of an event does, it closes when the change is saved.
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    expect(document.querySelector('form')).toBeNull()
    // said once, in a toast
    expect(notes.done.mock.calls).toEqual([['Large room was saved.']])
  })

  it('deactivates a resource in its dialog, which stays open, and reactivates another', async () => {
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(button(/^Deactivate Board room$/)).toBeDefined())
    expect(text(dialogEl()!.querySelector('[data-resource-activity]'))).toBe(
      'Deactivated resources take no new bookings; existing bookings stay.',
    )
    button(/^Deactivate Board room$/)!.click()
    await vi.waitFor(() => expect(rows()[0]).toContain('Inactive'))
    expect(sent('POST').map((call) => call.path)).toEqual(['/api/admin/resources/1/deactivate'])
    expect(api.refresh).toHaveBeenCalledTimes(1)
    expect(notes.done.mock.calls).toEqual([['Board room is deactivated.']])
    // the dialog stays and shows the new state
    await vi.waitFor(() => expect(button(/^Reactivate Board room$/)).toBeDefined())
    expect(text(dialogEl()!.querySelector('[data-resource-activity]'))).toContain(
      'This resource is deactivated',
    )
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())

    button(/^Edit Old van$/)!.click()
    await vi.waitFor(() => expect(button(/^Reactivate Old van$/)).toBeDefined())
    button(/^Reactivate Old van$/)!.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]).toMatchObject({
      path: '/api/admin/resources/2',
      body: { active: true },
    })
    await vi.waitFor(() => expect(rows()[1]).not.toContain('Inactive'))
    expect(dialogEl()).not.toBeNull()
  })
})

describe('the dialog of a resource', () => {
  const tab = (name: string) => tabs().find((item) => text(item) === name)!
  // A tab is chosen by the mouse button going down (or by the keyboard), not by `click`.
  const choose = (name: string) =>
    tab(name).dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }),
    )
  const aclCalls = () => calls.filter((call) => call.path.endsWith('/acl'))

  it('opens on the resource with "Edit", and on its access with "Access": the same dialog', async () => {
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    expect(text(dialogEl()!.querySelector('h2'))).toContain('Board room')
    expect(text(selected())).toBe('Resource')
    expect(field('Name').value).toBe('Board room')
    // Nothing about access was asked for a resource that is only edited.
    expect(aclCalls()).toEqual([])
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)

    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    button(/^Access for Board room$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    expect(text(selected())).toBe('Access')
    expect(text(dialogEl()!.querySelector('h2'))).toContain('Board room')
    await vi.waitFor(() => expect(ruleRows()).toHaveLength(2))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('gives focus back to the row button that opened it', async () => {
    await mountPage()
    await loaded()
    button(/^Access for Old van$/)!.focus()
    button(/^Access for Old van$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(button(/^Access for Old van$/)))
  })

  it('switches between the resource and its access without closing, and keeps what was typed', async () => {
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    fill('Name', 'Large room')
    choose('Access')
    await vi.waitFor(() => expect(ruleRows()).toHaveLength(2))
    expect(text(selected())).toBe('Access')
    choose('Resource')
    await vi.waitFor(() => expect(text(selected())).toBe('Resource'))
    expect(field('Name').value).toBe('Large room')
    // Back on the access tab the rules are not asked for again.
    choose('Access')
    await vi.waitFor(() => expect(text(selected())).toBe('Access'))
    expect(aclCalls()).toHaveLength(1)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('shows the tabs as tabs with a selected one, reachable by keyboard', async () => {
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tabs().map((item) => text(item))).toEqual(['Resource', 'Access'])
    expect(selected()).toBeDefined()
    expect(document.querySelectorAll('[role="tabpanel"]').length).toBeGreaterThan(0)
  })

  it('closes with Close and starts clean for the next resource', async () => {
    await mountPage()
    await loaded()
    button(/^Access for Board room$/)!.click()
    await vi.waitFor(() => expect(ruleRows()).toHaveLength(2))
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    button(/^Edit Old van$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    expect(field('Name').value).toBe('Old van')
    expect(ruleRows()).toEqual([])
  })

  it('shows nothing of a failed save when it is opened again', async () => {
    failure = {
      statusCode: 400,
      data: {
        statusCode: 400,
        message: 'The request is not valid',
        data: { fields: [{ field: 'name', message: 'is taken' }] },
      },
    }
    await mountPage()
    await loaded()
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(formButton(/Save changes/, 'Edit resource')).toBeDefined())
    formButton(/Save changes/, 'Edit resource')!.click()
    await vi.waitFor(() => expect(dialogEl()!.querySelector('[role="alert"]')).not.toBeNull())
    expect(text(dialogEl()!.querySelector('form [id$="-error"]'))).toContain('is taken')
    expect(notes.failed).toHaveBeenCalledTimes(1)
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).toBeNull())
    button(/^Edit Board room$/)!.click()
    await vi.waitFor(() => expect(dialogEl()).not.toBeNull())
    expect(dialogEl()!.querySelector('[role="alert"]')).toBeNull()
    expect(dialogEl()!.querySelector('[id$="-error"]')).toBeNull()
  })
})

describe('the rules of a resource', () => {
  async function open() {
    await mountPage()
    await loaded()
    button(/^Access for Board room$/)!.click()
    await vi.waitFor(() => expect(ruleRows()).toHaveLength(2))
  }

  it('lists who may do what, with names for people', async () => {
    await open()
    expect(ruleRows()[0]).toContain('Bob Builder')
    expect(ruleRows()[0]).toContain('Can manage')
    expect(ruleRows()[1]).toContain('Everyone signed in')
    expect(ruleRows()[1]).toContain('Can book')
    expect(document.querySelector('[data-resource-no-manager]')).toBeNull()
  })

  it('removes a rule by sending the complete list without it, and warns without a manager', async () => {
    await open()
    button(/^Remove Bob Builder \(bob\) from Board room$/)!.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]).toEqual({
      path: '/api/admin/resources/1/acl',
      method: 'PUT',
      body: { rules: [{ principalType: 'authenticated', principal: null, right: 'book' }] },
    })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-resource-no-manager]')).not.toBeNull(),
    )
  })

  it('adds a group with the chosen right to the complete list', async () => {
    await open()
    const whoMenu = () =>
      app
        .findAllComponents(USelectMenu)
        .find((menu) => menu.props('placeholder') === 'Choose a person or group')
    const levelSelect = () =>
      app
        .findAllComponents(USelect)
        .find((select) =>
          (select.props('items') as { value: string }[]).some((item) => item.value === 'manage'),
        )
    await vi.waitFor(() => expect(whoMenu()).toBeDefined())
    // the levels of a resource, "Can book" at first, explained under the select
    expect(levelSelect()!.props('modelValue')).toBe('book')
    expect(text(document.body)).toContain('Sees it and asks to book it.')
    whoMenu()!.vm.$emit('update:modelValue', 'group:staff')
    levelSelect()!.vm.$emit('update:modelValue', 'manage')
    await vi.waitFor(() => expect(text(document.body)).toContain('Also accepts or declines'))
    button(/^Add$/)!.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]?.body).toEqual({
      rules: [
        { principalType: 'user', principal: BOB, right: 'manage' },
        { principalType: 'authenticated', principal: null, right: 'book' },
        { principalType: 'group', principal: 'staff', right: 'manage' },
      ],
    })
    await vi.waitFor(() => expect(notes.done.mock.calls).toEqual([['staff can now: can manage.']]))
  })

  it('tells a refused change below the rules and in a toast', async () => {
    await open()
    failure = new TypeError('Failed to fetch')
    button(/^Remove Bob Builder \(bob\) from Board room$/)!.click()
    await vi.waitFor(() =>
      expect(text(dialogEl()!.querySelector('[role="alert"]'))).toContain('could not be reached'),
    )
    expect(notes.failed).toHaveBeenCalledTimes(1)
    const alert = dialogEl()!.querySelector('[role="alert"]')!
    const list = document.querySelector('[data-resource-rule]')!
    expect(list.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(ruleRows()).toHaveLength(2)
  })
})
