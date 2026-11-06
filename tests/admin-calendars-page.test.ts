// @vitest-environment nuxt
// Admin › Calendars inside a real Nuxt UI app, with a fake API behind `useAuthFetch`: who is sent
// away, what is listed and filtered, what a new calendar, a change and a delete send, and what an
// add or a remove of an access rule sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp, USelectMenu } from '#components'
import CalendarsPage from '~/pages/admin/calendars.vue'
import type { AccessCalendarsResponse } from '~/utils/admin/access'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
type Calendar = AccessCalendarsResponse['calendars'][number]
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(CalendarsPage) }) })

const ME = { id: 1, sub: 's', username: 'alice', name: 'Alice', email: null, timeZone: null }
const team = (): Calendar => ({
  id: 5,
  name: 'Team',
  kind: 'shared',
  color: null,
  owner: null,
  group: null,
  rules: [
    {
      id: 1,
      principalType: 'user',
      principal: 'u-bob',
      label: 'Bob Builder',
      permission: 'read',
      applied: true,
      appliedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: 2,
      principalType: 'group',
      principal: 'staff',
      label: 'staff',
      permission: 'write',
      applied: false,
      appliedAt: null,
    },
  ],
})
// Team (the organization's) first, then a person's, a group's and a resource's.
let list: Calendar[]
const calendars = (): AccessCalendarsResponse => ({ calendars: list })

const calls: { path: string; method: string; body: unknown }[] = []
let admin = true
let saveFailure: unknown = null
let app: Awaited<ReturnType<typeof mountSuspended>>
let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  calls.length = 0
  list = [
    team(),
    {
      ...team(),
      id: 6,
      name: 'Personal Calendar',
      kind: 'personal',
      owner: 'Bob Builder',
      rules: [],
    },
    { ...team(), id: 7, name: 'Rota', group: { id: 3, name: 'staff' }, rules: [] },
    { ...team(), id: 8, name: 'Room A', kind: 'resource', rules: [] },
  ]
  admin = true
  saveFailure = null
  replace = vi.fn(async () => undefined)
  vi.spyOn(useRouter(), 'replace').mockImplementation(replace as never)
  api.handler = async (path, options) => {
    calls.push({ path, method: options?.method ?? 'GET', body: options?.body })
    if (path === '/api/me') return { ...ME, isAdmin: admin }
    if (path === '/api/admin/access/calendars' && !options?.method) return calendars()
    // the links of the chosen calendar (their own tests: links-routes, e2e/admin-access.spec.ts)
    if (/^\/api\/admin\/access\/calendars\/\d+\/links$/.test(path) && !options?.method) {
      return { links: [] }
    }
    if (path === '/api/groups') return { groups: [{ name: 'staff' }, { name: 'nope' }] }
    if (path === '/api/admin/access/users')
      return { users: [{ sub: 'u-bob', name: 'Bob Builder', username: 'bob' }] }
    if (path === '/api/admin/access/calendars' && options?.method === 'POST') {
      const body = options.body as { name: string; color?: string }
      const made: Calendar = {
        ...team(),
        id: 9,
        name: body.name,
        color: body.color ?? null,
        rules: [],
      }
      return { calendar: made }
    }
    const one = /^\/api\/admin\/access\/calendars\/(\d+)$/.exec(path)
    if (one && options?.method === 'PATCH') {
      if (saveFailure) throw saveFailure
      const body = options.body as { name: string; color: string | null }
      const current = list.find((item) => item.id === Number(one[1]))!
      return { calendar: { ...current, ...body } }
    }
    if (one && options?.method === 'DELETE') {
      if (saveFailure) throw saveFailure
      return {}
    }
    if (options?.method === 'PUT') {
      if (saveFailure) throw saveFailure
      const rules = (
        options.body as {
          rules: { principalType: string; principal: string | null; permission: string }[]
        }
      ).rules
      const base = team()
      return {
        changed: true,
        calendar: {
          ...base,
          rules: rules.map((rule, index) => ({
            ...rule,
            id: 10 + index,
            label: rule.principal ?? 'Everyone signed in',
            applied: false,
            appliedAt: null,
          })),
        },
      }
    }
    throw new Error(`unexpected ${path}`)
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

/** Picks a group in the "Group" drop-down of the add form. */
async function chooseGroup(name: string) {
  await vi.waitFor(() => expect(groupMenu()).toBeDefined())
  groupMenu()!.vm.$emit('update:modelValue', name)
  await nextTick()
}
const groupMenu = () =>
  app.findAllComponents(USelectMenu).find((menu) => menu.props('placeholder') === 'Choose a group')

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const rules = () => [...document.querySelectorAll('[data-access-rule]')].map((li) => text(li))
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''),
  )
function radio(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('label')].find((item) =>
    text(item)?.startsWith(label),
  )
  return document.getElementById(found?.getAttribute('for') ?? '') as HTMLButtonElement
}
const puts = () => calls.filter((call) => call.method === 'PUT')
const sent = (method: string) => calls.filter((call) => call.method === method)
const rows = () => [...document.querySelectorAll('[data-admin-calendar]')].map((li) => text(li))
const dialog = () => document.querySelector('[role="dialog"]')

/** Opens the dialog of a calendar on its access tab, where the rules are. */
async function openAccess(name = 'Team') {
  await vi.waitFor(() => expect(button(new RegExp(`^Access for ${name}$`))).toBeDefined())
  button(new RegExp(`^Access for ${name}$`))!.click()
  await vi.waitFor(() => expect(rules().length).toBeGreaterThan(0))
}

function typeInto(label: string, value: string) {
  const input = document.getElementById(
    [...document.querySelectorAll('label')]
      .find((item) => text(item)?.startsWith(label))!
      .getAttribute('for')!,
  ) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('who sees the page', () => {
  it('sends a user who is not an admin back to the calendar without asking for the rules', async () => {
    admin = false
    await mountPage()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(calls.map((call) => call.path)).toEqual(['/api/me'])
    expect(document.querySelector('[data-access-rule]')).toBeNull()
  })

  it('offers a retry when it cannot tell who the user is', async () => {
    api.handler = async () => {
      throw new TypeError('Failed to fetch')
    }
    await mountPage()
    // mountSuspended itself navigates to '/' while it sets the route up.
    replace.mockClear()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
    expect(replace).not.toHaveBeenCalled()
    expect(button(/^Retry$/)).toBeDefined()
  })
})

describe('as an admin', () => {
  it('lists every calendar with whom it belongs to, and filters and searches them', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(4))
    expect(document.querySelector('h1')?.textContent).toBe('Calendars')
    expect(rows()[0]).toContain('Calendar of the organization · 2 access rules')
    expect(rows()[1]).toContain('Calendar of Bob Builder · 0 access rules')
    expect(rows()[2]).toContain('Calendar of the group staff')
    expect(rows()[3]).toContain('Calendar of a resource')
    // A person's calendar is named with its owner, to tell it from others of that name.
    expect(button(/^Edit Personal Calendar \(Bob Builder\)$/)).toBeDefined()
    radio('People').click()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toContain('Personal Calendar')
    radio('Groups').click()
    await vi.waitFor(() => expect(rows()).toEqual([expect.stringContaining('Rota')]))
    radio('All').click()
    typeInto('Search calendars', 'bob')
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    typeInto('Search calendars', 'nothing like it')
    await vi.waitFor(() => expect(document.querySelector('[data-calendars-none]')).not.toBeNull())
  })

  it('lists the rules of a calendar with who, what and whether they are applied', async () => {
    await mountPage()
    await openAccess()
    expect(rules()).toHaveLength(2)
    expect(rules()[0]).toContain('Bob Builder')
    expect(rules()[0]).toContain('Can view')
    expect(rules()[0]).toContain('Applied')
    expect(rules()[1]).toContain('staff')
    expect(rules()[1]).toContain('Can edit')
    expect(rules()[1]).toContain('Pending')
    expect(text(document.body)).toContain('1 rule is pending')
  })

  it('makes a calendar of the organization and opens it on who has access', async () => {
    await mountPage()
    await vi.waitFor(() => expect(button(/^New calendar$/)?.disabled).toBe(false))
    button(/^New calendar$/)!.click()
    await vi.waitFor(() => expect(button(/^Add calendar$/)).toBeDefined())
    expect(text(dialog())).toContain('nobody sees it until you give people or groups access')
    typeInto('Name', 'Board')
    button(/^Add calendar$/)!.click()
    await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
    expect(sent('POST')[0]).toMatchObject({
      path: '/api/admin/access/calendars',
      body: { name: 'Board', color: '#1d4ed8' },
    })
    await vi.waitFor(() => expect(text(dialog())).toContain('Who has access'))
    expect(text(dialog())).toContain('This calendar belongs to the organization')
    expect(text(document.body)).toContain('Board was added. Nobody sees it')
    expect(rows().some((row) => row?.includes('Board'))).toBe(true)
  })

  it('renames a calendar on its details tab and sends its own colour', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(4))
    button(/^Edit Team$/)!.click()
    await vi.waitFor(() => expect(button(/^Save changes$/)).toBeDefined())
    typeInto('Name', 'Team plan')
    button(/^Save changes$/)!.click()
    await vi.waitFor(() => expect(sent('PATCH')).toHaveLength(1))
    expect(sent('PATCH')[0]).toMatchObject({
      path: '/api/admin/access/calendars/5',
      body: { name: 'Team plan', color: null },
    })
    await vi.waitFor(() => expect(rows()[0]).toContain('Team plan'))
  })

  it('deletes a calendar after asking, and keeps a resource’s for the Resources page', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(4))
    button(/^Edit Room A$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('deleted with its resource'))
    expect(button(/^Delete calendar$/)).toBeUndefined()
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())

    button(/^Edit Personal Calendar \(Bob Builder\)$/)!.click()
    await vi.waitFor(() => expect(button(/^Delete calendar$/)).toBeDefined())
    expect(text(dialog())).toContain('The calendar of Bob Builder and all its events are deleted')
    button(/^Delete calendar$/)!.click()
    await vi.waitFor(() =>
      expect(text(document.body)).toContain('Delete "Personal Calendar (Bob Builder)"?'),
    )
    expect(sent('DELETE')).toHaveLength(0)
    button(/^Delete$/)!.click()
    await vi.waitFor(() => expect(sent('DELETE')).toHaveLength(1))
    expect(sent('DELETE')[0]!.path).toBe('/api/admin/access/calendars/6')
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
  })

  it('keeps the calendar and says why when the calendar server did not delete it', async () => {
    saveFailure = {
      statusCode: 502,
      data: { statusCode: 502, message: 'x', data: { code: 'upstream_unavailable' } },
    }
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(4))
    button(/^Edit Team$/)!.click()
    await vi.waitFor(() => expect(button(/^Delete calendar$/)).toBeDefined())
    button(/^Delete calendar$/)!.click()
    await vi.waitFor(() => expect(button(/^Delete$/)).toBeDefined())
    button(/^Delete$/)!.click()
    await vi.waitFor(() =>
      expect(text(document.body)).toContain(
        'Could not delete the calendar. The calendar server did not do it; nothing was changed.',
      ),
    )
    expect(rows()).toHaveLength(4)
  })

  it('removes a rule by sending the list without it', async () => {
    await mountPage()
    await openAccess()
    button(/^Remove Bob Builder from Team$/)!.click()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]).toMatchObject({
      path: '/api/admin/access/calendars/5',
      body: { rules: [{ principalType: 'group', principal: 'staff', permission: 'write' }] },
    })
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="status"][aria-live]')].map(text).join(' '),
      ).toContain('no longer has access'),
    )
  })

  it('adds a rule for everyone signed in at the chosen level', async () => {
    await mountPage()
    await openAccess()
    radio('Everyone signed in').click()
    radio('Busy times only').click()
    await vi.waitFor(() =>
      expect(radio('Busy times only').getAttribute('aria-checked')).toBe('true'),
    )
    button(/^Add access$/)!.click()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      rules: [
        { principalType: 'user', principal: 'u-bob', permission: 'read' },
        { principalType: 'group', principal: 'staff', permission: 'write' },
        { principalType: 'authenticated', principal: null, permission: 'free_busy' },
      ],
    })
  })

  it('offers the groups of the Groups page to choose from, and sends nothing without one', async () => {
    await mountPage()
    await openAccess()
    radio('A group').click()
    await vi.waitFor(() => expect(groupMenu()).toBeDefined())
    expect(groupMenu()!.props('items')).toEqual([
      { value: 'staff', label: 'staff' },
      { value: 'nope', label: 'nope' },
    ])
    expect(calls.some((call) => call.path === '/api/groups')).toBe(true)
    button(/^Add access$/)!.click()
    await vi.waitFor(() => expect(text(document.body)).toContain('Choose a group.'))
    expect(puts()).toHaveLength(0)
  })

  it('names the rule the server refused and keeps the list', async () => {
    saveFailure = {
      statusCode: 400,
      data: {
        statusCode: 400,
        message: 'The request is not valid',
        data: {
          fields: [
            {
              field: 'rules[2].principal',
              message: 'is not a known group; an administrator can import it on the Groups page',
            },
          ],
        },
      },
    }
    await mountPage()
    await openAccess()
    radio('A group').click()
    // listed, but gone on the server by the time the rule is sent
    await chooseGroup('nope')
    button(/^Add access$/)!.click()
    await vi.waitFor(() =>
      expect(text(document.querySelector('[role="alert"]'))).toContain(
        'Nothing was changed. Group nope is not a known group; an administrator can import it on the Groups page.',
      ),
    )
    expect(rules()).toHaveLength(2)
  })

  it('offers the group choice always: the groups are the app’s own, no server setting is needed', async () => {
    await mountPage()
    await openAccess()
    expect(radio('A group').hasAttribute('disabled')).toBe(false)
    expect(text(document.body)).not.toContain('Kanidm')
  })
})
