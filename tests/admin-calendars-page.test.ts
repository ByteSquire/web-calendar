// @vitest-environment nuxt
// Admin › Calendars inside a real Nuxt UI app, with a fake API behind `useAuthFetch`: who is sent
// away, what is listed and filtered, what a new calendar, a change and a delete send, what an add or
// a remove of an access rule sends, and what is told where (toasts, and failures in place too).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp, USelect, USelectMenu } from '#components'
import CalendarsPage from '~/pages/admin/calendars.vue'
import type { AccessCalendarsResponse } from '~/utils/admin/access'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
type Calendar = AccessCalendarsResponse['calendars'][number]
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))
// What the page and its dialog toast.
const notes = vi.hoisted(() => ({ done: vi.fn(), failed: vi.fn() }))
vi.mock('~/composables/useNotify', () => ({ useNotify: () => notes }))

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
  notes.done.mockReset()
  notes.failed.mockReset()
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

/** Picks who gets access in the "Who" list of the add row: `group:<name>`, `user:<sub>`, ... */
async function chooseWho(value: string) {
  await vi.waitFor(() => expect(whoMenu()).toBeDefined())
  whoMenu()!.vm.$emit('update:modelValue', value)
  await nextTick()
}
const whoMenu = () =>
  app
    .findAllComponents(USelectMenu)
    .find((menu) => menu.props('placeholder') === 'Choose a person or group')
/** The select of the add row's "Level", or of the page's "Show". */
const selectWith = (value: string) =>
  app
    .findAllComponents(USelect)
    .find((select) =>
      (select.props('items') as { value: string }[]).some((item) => item.value === value),
    )
async function choose(value: string) {
  selectWith(value)!.vm.$emit('update:modelValue', value)
  await nextTick()
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const rules = () => [...document.querySelectorAll('[data-access-rule]')].map((li) => text(li))
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''),
  )
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
    // "Show" is a select in the row of the search
    expect(
      (selectWith('organization')!.props('items') as { label: string }[]).map((item) => item.label),
    ).toEqual(['All', 'People', 'Organization', 'Groups', 'Resources'])
    await choose('people')
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toContain('Personal Calendar')
    await choose('groups')
    await vi.waitFor(() => expect(rows()).toEqual([expect.stringContaining('Rota')]))
    await choose('all')
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
    // said once, in a toast: nothing above the list comes and goes
    expect(notes.done.mock.calls).toEqual([
      ['Board was added. Nobody sees it until you give people or groups access.'],
    ])
    expect(document.querySelector('[role="status"][aria-live]')).toBeNull()
    expect(rows().some((row) => row?.includes('Board'))).toBe(true)
  })

  it('puts focus in the name of a new calendar, and back on "New calendar" after Cancel or Escape', async () => {
    await mountPage()
    await vi.waitFor(() => expect(button(/^New calendar$/)?.disabled).toBe(false))
    for (const leave of ['Cancel', 'Escape']) {
      button(/^New calendar$/)!.focus()
      button(/^New calendar$/)!.click()
      await vi.waitFor(() => expect(button(/^Add calendar$/)).toBeDefined())
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(dialog()!.querySelector('input[maxlength="100"]')),
      )
      if (leave === 'Cancel') button(/^Cancel$/)!.click()
      else
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      await vi.waitFor(() => expect(dialog()).toBeNull())
      await vi.waitFor(() => expect(document.activeElement).toBe(button(/^New calendar$/)))
    }
  })

  it('after a new calendar, gives focus to its Edit button when its dialog closes', async () => {
    await mountPage()
    await vi.waitFor(() => expect(button(/^New calendar$/)?.disabled).toBe(false))
    button(/^New calendar$/)!.focus()
    button(/^New calendar$/)!.click()
    await vi.waitFor(() => expect(button(/^Add calendar$/)).toBeDefined())
    typeInto('Name', 'Board')
    button(/^Add calendar$/)!.focus()
    button(/^Add calendar$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Who has access'))
    // the new calendar's dialog keeps the focus: it is not sent back behind it
    await vi.waitFor(() => expect(dialog()!.contains(document.activeElement)).toBe(true))
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(button(/^Edit Board$/)))
  })

  it('gives focus back to the row button that opened a dialog, and to "New calendar" after a delete', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(4))
    button(/^Access for Team$/)!.focus()
    button(/^Access for Team$/)!.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(button(/^Access for Team$/)))

    button(/^Edit Team$/)!.focus()
    button(/^Edit Team$/)!.click()
    await vi.waitFor(() => expect(button(/^Delete calendar$/)).toBeDefined())
    button(/^Delete calendar$/)!.click()
    await vi.waitFor(() => expect(button(/^Delete$/)).toBeDefined())
    button(/^Delete$/)!.click()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(button(/^New calendar$/)))
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
    expect(notes.done).toHaveBeenCalledWith('Team plan was saved.')
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
    expect(notes.done.mock.calls).toEqual([['Personal Calendar (Bob Builder) was deleted.']])
  })

  it('offers no Delete for a person’s default calendar, and says why', async () => {
    list = list.map((item) => (item.id === 6 ? { ...item, isDefault: true } : item))
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(4))
    button(/^Edit Personal Calendar \(Bob Builder\)$/)!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-default-calendar]')).not.toBeNull())
    expect(text(document.querySelector('[data-default-calendar]'))).toContain(
      'This is the default calendar of Bob Builder',
    )
    expect(button(/^Delete calendar$/)).toBeUndefined()
    // it is still renamed
    expect(button(/^Save changes$/)).toBeDefined()
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
    const why =
      'Could not delete the calendar. The calendar server did not do it; nothing was changed.'
    // in the question that asked, and in a toast
    await vi.waitFor(() => expect(text(document.body)).toContain(why))
    expect(notes.failed.mock.calls).toEqual([[expect.stringContaining(why)]])
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
      expect(notes.done).toHaveBeenCalledWith('Bob Builder no longer has access.'),
    )
  })

  it('adds a rule for everyone signed in at the chosen level, with the level explained', async () => {
    await mountPage()
    await openAccess()
    const form = () => document.querySelector('form[aria-label="Add access"]')
    // the explanation of the level is always there; only its words change
    expect(text(form())).toContain('Sees all events and their details.')
    await chooseWho('authenticated')
    await choose('free_busy')
    await vi.waitFor(() => expect(text(form())).toContain('Sees when the calendar is busy'))
    button(/^Add$/)!.click()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      rules: [
        { principalType: 'user', principal: 'u-bob', permission: 'read' },
        { principalType: 'group', principal: 'staff', permission: 'write' },
        { principalType: 'authenticated', principal: null, permission: 'free_busy' },
      ],
    })
    await vi.waitFor(() =>
      expect(notes.done).toHaveBeenCalledWith(
        'Access for Everyone signed in is now: Busy times only.',
      ),
    )
    // "Who" is cleared for the next one; the level stays
    await vi.waitFor(() => expect(whoMenu()!.props('modelValue')).toBeUndefined())
    expect(text(form())).toContain('Sees when the calendar is busy')
  })

  it('changes the level of somebody who has a rule already', async () => {
    await mountPage()
    await openAccess()
    await chooseWho('user:u-bob')
    await choose('write')
    button(/^Add$/)!.click()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      rules: [
        { principalType: 'user', principal: 'u-bob', permission: 'write' },
        { principalType: 'group', principal: 'staff', permission: 'write' },
      ],
    })
  })

  it('offers everyone, the groups of the Groups page and the people in one list, and sends nothing without a choice', async () => {
    await mountPage()
    await openAccess()
    await vi.waitFor(() => expect(whoMenu()).toBeDefined())
    expect(whoMenu()!.props('items')).toEqual([
      [{ value: 'authenticated', label: 'Everyone signed in', icon: 'i-lucide-globe' }],
      [
        { value: 'group:staff', label: 'Group staff', icon: 'i-lucide-users' },
        { value: 'group:nope', label: 'Group nope', icon: 'i-lucide-users' },
      ],
      [{ value: 'user:u-bob', label: 'Bob Builder (bob)', icon: 'i-lucide-user' }],
    ])
    expect(calls.some((call) => call.path === '/api/groups')).toBe(true)
    button(/^Add$/)!.click()
    // on the field, and nothing sent or toasted
    await vi.waitFor(() =>
      expect(text(document.querySelector('form[aria-label="Add access"]'))).toContain(
        'Choose who gets access.',
      ),
    )
    expect(puts()).toHaveLength(0)
    expect(notes.failed).not.toHaveBeenCalled()
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
    // listed, but gone on the server by the time the rule is sent
    await chooseWho('group:nope')
    button(/^Add$/)!.click()
    const why =
      'Nothing was changed. Group nope is not a known group; an administrator can import it on the Groups page.'
    await vi.waitFor(() => expect(text(document.querySelector('[role="alert"]'))).toContain(why))
    expect(notes.failed.mock.calls).toEqual([[why]])
    expect(rules()).toHaveLength(2)
    // below the rules, near where it happened, so the list does not move
    const alert = document.querySelector('[role="alert"]')!
    const list = document.querySelector('[data-access-rule]')!
    expect(list.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // "Who" keeps the choice, to try again
    expect(whoMenu()!.props('modelValue')).toBe('group:nope')
  })

  it('shows nothing of a failed change when the dialog is opened again', async () => {
    saveFailure = new TypeError('Failed to fetch')
    await mountPage()
    await openAccess()
    button(/^Remove Bob Builder from Team$/)!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
    button(/^Close$/)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await openAccess()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('offers the groups always: they are the app’s own, no server setting is needed', async () => {
    await mountPage()
    await openAccess()
    await vi.waitFor(() => expect(whoMenu()).toBeDefined())
    expect((whoMenu()!.props('items') as unknown[][]).flat()).toContainEqual(
      expect.objectContaining({ value: 'group:staff' }),
    )
    expect(text(document.body)).not.toContain('Kanidm')
  })
})
