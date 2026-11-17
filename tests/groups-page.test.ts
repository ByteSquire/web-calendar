// @vitest-environment nuxt
// The groups pages inside a real Nuxt UI app, with a fake API behind `useAuthFetch`: the list
// (/groups) with what a member and an admin see, the "New group" dialog and the groups of the
// identity provider; the page of one group (/groups/<id>) with its members, saved at once, and its
// calendars, created in a dialog and edited in the dialog of a group calendar; a group the person
// may not see, and the retry after a failed load. What a change came to is a toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import GroupsPage from '~/pages/groups/index.vue'
import GroupPage from '~/pages/groups/[id].vue'
import type { GroupDetail, GroupSummary, OidcCandidate } from '~/utils/groups/model'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))

const ListShell = defineComponent({
  render: () => h(UApp, null, { default: () => h(GroupsPage) }),
})
const GroupShell = defineComponent({
  render: () => h(UApp, null, { default: () => h(GroupPage) }),
})

const ME = { id: 1, sub: 'sub-me', username: 'me', name: 'Me', email: null, timeZone: null }
const PEOPLE = [
  { sub: 'sub-anna', name: 'Anna', username: 'anna' },
  { sub: 'sub-bob', name: 'Bob', username: 'bob' },
]

let admin = false
let groups: GroupSummary[]
let details: Record<number, GroupDetail>
let failGroups = false
let failGroup = 0
let candidateList: OidcCandidate[]
let stopFailure: unknown = null
let importFailure: unknown = null
let createFailure: unknown = null
let membersFailure: unknown = null
const calls: { path: string; method: string; body: unknown }[] = []
let app: Awaited<ReturnType<typeof mountSuspended>>

// The person manages staff (they may change its members and calendars) unless a test says not.
let manages = true

const start = (): GroupSummary[] => [
  { id: 1, name: 'staff', source: 'app', memberCount: 1, member: true, manager: true },
  { id: 2, name: 'it', source: 'oidc', memberCount: 2, member: true, manager: false },
]

function detailOf(id: number): GroupDetail {
  return {
    id,
    name: id === 1 ? 'staff' : id === 2 ? 'it' : 'web_calendar_users',
    source: id === 1 ? 'app' : id === 2 ? 'oidc' : 'everyone',
    canManageMembers: id === 1 && (admin || manages),
    canManageCalendars: id !== 3 && (admin || (id === 1 && manages)),
    canNameManagers: id !== 3 && admin,
    members: id === 1 ? [{ sub: 'sub-me', name: 'Me', username: 'me', manager: manages }] : [],
    calendars:
      id === 3
        ? []
        : [
            {
              id: 10,
              name: 'Team calendar',
              color: '#047857',
              shares: [
                {
                  principalType: 'group',
                  principal: id === 1 ? 'staff' : 'it',
                  label: 'staff',
                  permission: 'write',
                },
              ],
            },
          ],
  }
}

const httpError = (statusCode: number, message: string, code?: string) =>
  Object.assign(new Error(message), {
    statusCode,
    data: { statusCode, message, ...(code ? { code } : {}) },
  })

beforeEach(() => {
  admin = false
  manages = true
  failGroups = false
  failGroup = 0
  stopFailure = null
  importFailure = null
  createFailure = null
  membersFailure = null
  candidateList = [
    {
      id: 'k-ops',
      name: 'ops',
      imported: false,
      groupId: null,
      memberCount: 0,
      lastSeenAt: '2026-11-01T10:00:00.000Z',
      blocked: null,
    },
    {
      id: 'k-it',
      name: 'it',
      imported: true,
      groupId: 2,
      memberCount: 2,
      lastSeenAt: '2026-11-01T10:00:00.000Z',
      blocked: null,
    },
    {
      id: 'k-staff',
      name: 'Staff',
      imported: false,
      groupId: null,
      memberCount: 0,
      lastSeenAt: '2026-11-01T10:00:00.000Z',
      blocked: 'name_taken',
    },
    {
      id: 'k-twin1',
      name: 'twin',
      imported: false,
      groupId: null,
      memberCount: 0,
      lastSeenAt: '2026-11-01T10:00:00.000Z',
      blocked: 'conflict',
    },
  ]
  calls.length = 0
  groups = start()
  details = { 1: detailOf(1), 2: detailOf(2) }
  api.handler = async (path, options) => {
    const method = options?.method ?? 'GET'
    calls.push({ path, method, body: options?.body })
    if (path === '/api/me') return { ...ME, isAdmin: admin }
    if (path === '/api/people') return { people: PEOPLE }
    if (path === '/api/groups' && method === 'GET') {
      if (failGroups) {
        failGroups = false
        throw Object.assign(new Error('boom'), { statusCode: 500 })
      }
      return { groups }
    }
    if (path === '/api/groups' && method === 'POST') {
      if (createFailure) throw createFailure
      const { name } = options?.body as { name: string }
      return {
        group: { id: 5, name, source: 'app', memberCount: 0, member: false, manager: false },
      }
    }
    if (path === '/api/groups/oidc' && method === 'GET') {
      return { candidates: candidateList, truncated: false }
    }
    if (path === '/api/groups/oidc' && method === 'POST') {
      if (importFailure) throw importFailure
      const { externalId } = options?.body as { externalId: string }
      const candidate = candidateList.find((item) => item.id === externalId)!
      return {
        group: {
          id: 7,
          name: candidate.name,
          source: 'oidc',
          memberCount: 0,
          member: false,
          manager: false,
        },
      }
    }
    const stop = /^\/api\/groups\/oidc\/(\d+)$/.exec(path)
    if (stop && method === 'DELETE') {
      if (stopFailure) throw stopFailure
      return { removed: { calendarRules: 1, resourceRules: 0 } }
    }
    const group = /^\/api\/groups\/(\d+)$/.exec(path)
    if (group && method === 'GET') {
      if (failGroup > 0) {
        failGroup -= 1
        throw Object.assign(new Error('boom'), { statusCode: 500 })
      }
      const found = details[Number(group[1])]
      if (!found) throw httpError(403, 'Forbidden')
      return found
    }
    if (group && method === 'DELETE') {
      return {}
    }
    if (path === '/api/groups/1/calendars' && method === 'POST') {
      const body = options?.body as { name: string; color?: string }
      const created = { id: 11, name: body.name, color: body.color ?? null, shares: [] }
      details[1]!.calendars.push(created)
      return { calendar: created }
    }
    if (path === '/api/groups/1/calendars/10' && method === 'PATCH') {
      const body = options?.body as { name: string; color: string | null }
      const saved = { ...details[1]!.calendars[0]!, ...body }
      details[1]!.calendars[0] = saved
      return { calendar: saved }
    }
    const shares = /^\/api\/groups\/1\/calendars\/10\/shares$/.exec(path)
    if (shares && method === 'PUT') {
      const body = options?.body as {
        shares: { principal: string; principalType: string; permission: string }[]
      }
      const extra = body.shares.map((item) => ({
        ...item,
        label: item.principal,
      }))
      const saved = {
        ...details[1]!.calendars[0]!,
        shares: [details[1]!.calendars[0]!.shares[0]!, ...extra],
      }
      details[1]!.calendars[0] = saved as never
      return { calendar: saved }
    }
    if (path === '/api/groups/1/members' && method === 'PUT') {
      if (membersFailure) throw membersFailure
      const body = options?.body as { members: string[] }
      const members = body.members.map(
        (sub) =>
          details[1]!.members.find((member) => member.sub === sub) ?? {
            ...PEOPLE.find((person) => person.sub === sub)!,
            manager: false,
          },
      )
      details[1]!.members = members
      return { members }
    }
    if (path === '/api/groups/1/managers' && method === 'PUT') {
      const body = options?.body as { managers: string[] }
      const members = details[1]!.members.map((member) => ({
        ...member,
        manager: body.managers.includes(member.sub),
      }))
      details[1]!.members = members
      return { members }
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
})

afterEach(() => {
  app.unmount()
  api.handler = null
  document.body.innerHTML = ''
  clearNuxtState()
  vi.restoreAllMocks()
})

async function mountList() {
  // The route guard lets the address through only with a session.
  useState('auth-status').value = 'authenticated'
  app = await mountSuspended(ListShell, { attachTo: document.body, route: '/groups' })
}

/** The page of one group; it is there once its heading is. */
async function mountGroup(id: number | string, heading = id === 1 ? 'staff' : 'it') {
  // The route guard lets the address through only with a session.
  useState('auth-status').value = 'authenticated'
  app = await mountSuspended(GroupShell, { attachTo: document.body, route: `/groups/${id}` })
  await vi.waitFor(() => expect(text(document.querySelector('h1'))).toBe(heading))
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const rows = () => [...document.querySelectorAll('[data-group]')].map((li) => text(li))
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? ''),
  )
const dialog = () => document.querySelector('[role="dialog"]')
const dialogButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (item) => text(item) === name,
  )
const sent = (method: string) => calls.filter((call) => call.method === method)
const field = (label: string) =>
  [...document.querySelectorAll('label')].find((item) => text(item)?.startsWith(label))
const inputOf = (label: string) =>
  document.getElementById(field(label)!.getAttribute('for')!) as HTMLInputElement

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the list of groups', () => {
  it('lists only the groups the person is in, each with a link to its page', async () => {
    groups = [
      ...start(),
      { id: 3, name: 'board', source: 'app', memberCount: 4, member: false, manager: false },
    ]
    await mountList()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().join(' ')).not.toContain('board')
    const open = document.querySelector<HTMLAnchorElement>('a[aria-label="Open staff"]')
    expect(open?.getAttribute('href')).toBe('/groups/1')
    expect(document.querySelector('a[aria-label="Open board"]')).toBeNull()
  })

  it('lists the groups with their source, member count and the person’s role', async () => {
    groups = start().map((group) => (group.id === 2 ? group : { ...group, manager: true }))
    await mountList()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]).toContain('staff')
    expect(rows()[0]).toContain('Created in this app')
    expect(rows()[0]).toContain('You manage this group')
    expect(rows()[1]).toContain('From your identity provider')
    expect(rows()[1]).toContain('2 members')
    expect(rows()[1]).toContain('You are a member')
    // Only admins get "New group" and the delete buttons.
    expect(button(/^New group$/)).toBeUndefined()
    expect(button(/^Delete group staff$/)).toBeUndefined()
  })

  it('shows the error of the list with a retry that loads it again', async () => {
    failGroups = true
    await mountList()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not load the groups',
      ),
    )
    expect(rows()).toHaveLength(0)
    button(/^Retry$/)!.click()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
  })

  describe('for an admin', () => {
    beforeEach(() => {
      admin = true
    })

    async function openNewGroup() {
      await mountList()
      await vi.waitFor(() => expect(rows()).toHaveLength(2))
      button(/^New group$/)!.click()
      await vi.waitFor(() => expect(field('Group name')).toBeDefined())
    }

    it('creates a group in a dialog that closes, says so and lists it', async () => {
      await openNewGroup()
      type(inputOf('Group name'), 'kitchen')
      dialogButton('Create group')!.click()
      await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
      expect(sent('POST')[0]).toMatchObject({ path: '/api/groups', body: { name: 'kitchen' } })
      await vi.waitFor(() => expect(dialog()).toBeNull())
      expect(rows().join(' ')).toContain('kitchen')
      expect(document.body.textContent).toContain('kitchen was created.')
    })

    it('keeps the dialog open with the server’s words when the name is taken', async () => {
      createFailure = httpError(409, 'A group with this name already exists.')
      await openNewGroup()
      type(inputOf('Group name'), 'staff')
      dialogButton('Create group')!.click()
      await vi.waitFor(() =>
        expect(text(dialog()?.querySelector('[role="alert"]'))).toContain(
          'A group with this name already exists.',
        ),
      )
      expect(dialog()).not.toBeNull()
    })

    it('refuses a bad group name before sending anything', async () => {
      await openNewGroup()
      type(inputOf('Group name'), '-bad')
      dialogButton('Create group')!.click()
      await vi.waitFor(() => expect(text(dialog())).toContain('Start with a letter or a digit'))
      expect(sent('POST')).toHaveLength(0)
    })

    it('starts the dialog afresh after it was cancelled', async () => {
      await openNewGroup()
      type(inputOf('Group name'), 'half-typed')
      dialogButton('Cancel')!.click()
      await vi.waitFor(() => expect(dialog()).toBeNull())
      button(/^New group$/)!.click()
      await vi.waitFor(() => expect(field('Group name')).toBeDefined())
      expect(inputOf('Group name').value).toBe('')
    })

    it('deletes a custom group after asking', async () => {
      await mountList()
      await vi.waitFor(() => expect(rows()).toHaveLength(2))
      expect(button(/^Delete group it$/)).toBeUndefined()
      button(/^Delete group staff$/)!.click()
      await vi.waitFor(() => expect(text(dialog())).toContain('Delete staff?'))
      dialogButton('Delete')!.click()
      await vi.waitFor(() => expect(rows()).toHaveLength(1))
      expect(sent('DELETE')[0]!.path).toBe('/api/groups/1')
      expect(document.body.textContent).toContain('staff was deleted.')
    })
  })
})

describe('the page of a group', () => {
  it('shows its name as the focused heading, its source and member count', async () => {
    await mountGroup(1)
    expect(document.activeElement?.tagName).toBe('H1')
    expect(text(document.querySelector('[data-group-summary]'))).toBe(
      'Created in this app · 1 member',
    )
    expect(document.querySelector('a[href="/groups"]')?.textContent).toContain('Back to groups')
  })

  it('says so when the group is not there for the person, with the way back', async () => {
    await mountGroup(9, 'Group not found')
    expect(document.querySelector('[data-group-missing]')).not.toBeNull()
    expect(document.querySelector('a[href="/groups"]')).not.toBeNull()
    expect(document.querySelector('[data-group-calendar]')).toBeNull()
  })

  it('shows a failed load with a retry that loads it again', async () => {
    failGroup = 1
    await mountGroup(1, 'Group')
    expect(text(document.querySelector('[role="alert"]'))).toContain('Could not load the group')
    button(/^Retry$/)!.click()
    await vi.waitFor(() => expect(text(document.querySelector('h1'))).toBe('staff'))
    expect(document.querySelector('[data-group-calendar]')).not.toBeNull()
  })

  it('offers all groups to share with', async () => {
    groups = [
      ...start(),
      { id: 3, name: 'board', source: 'app', memberCount: 4, member: false, manager: false },
    ]
    await mountGroup(1)
    button(/^Share Team calendar$/)!.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]')]
    expect(radio.length).toBeGreaterThan(0)
  })

  it('shows a member who does not manage the group its calendars, without changing them', async () => {
    manages = false
    details = { 1: detailOf(1), 2: detailOf(2) }
    await mountGroup(1)
    expect(document.querySelector('[data-group-calendar]')?.textContent).toContain('Team calendar')
    for (const name of [/^Edit Team calendar$/, /^Share Team calendar$/, /^New calendar$/]) {
      expect(button(name)).toBeUndefined()
    }
    expect(button(/^Remove /)).toBeUndefined()
    expect(button(/^Make /)).toBeUndefined()
    expect(button(/^Add$/)).toBeUndefined()
  })

  it('shows a manager as such, and gives them no way to remove a manager or name one', async () => {
    await mountGroup(1)
    expect(text(document.querySelector('[data-group-member]'))).toContain('Manager')
    expect(button(/^Remove Me \(me\) from staff$/)).toBeUndefined()
    expect(button(/^Make /)).toBeUndefined()
    expect(button(/^New calendar$/)).toBeDefined()
  })

  it('says under the Add row when the people offered are not everybody, and not otherwise', async () => {
    await mountGroup(1)
    expect(document.body.textContent).not.toContain('Not everybody is offered')

    app.unmount()
    document.body.innerHTML = ''
    const handler = api.handler!
    api.handler = (async (path: string, options?: { method?: string; body?: unknown }) =>
      path === '/api/people'
        ? { people: PEOPLE, truncated: true }
        : handler(path, options)) as Handler
    await mountGroup(1)
    const form = document.querySelector('form[aria-labelledby="group-members-add-heading"]')
    expect(text(form)).toContain(
      `Not everybody is offered when you add members or share: the list shows the first ${PEOPLE.length} people`,
    )
  })

  it('creates a calendar with a colour in a dialog that closes and says so', async () => {
    await mountGroup(1)
    // No form until it is asked for.
    expect(document.querySelectorAll('form').length).toBe(1)
    button(/^New calendar$/)!.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(dialog()!.querySelector('input')!, '  Kitchen plan ')
    dialogButton('Add calendar')!.click()
    await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
    expect(sent('POST')[0]!.body).toEqual({ name: 'Kitchen plan', color: '#1d4ed8' })
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.querySelectorAll('[data-group-calendar]')).toHaveLength(2)
    expect(document.body.textContent).toContain('Kitchen plan was added.')
  })

  it('edits a calendar in its dialog, and the row follows what was saved', async () => {
    await mountGroup(1)
    expect(button(/^Delete Team calendar$/)).toBeUndefined()
    button(/^Edit Team calendar$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('A calendar of the group staff.'))
    expect(button(/^Delete calendar$/)).toBeDefined()
    const name = dialog()!.querySelector<HTMLInputElement>('input[autocomplete="off"]')!
    type(name, 'Rota')
    button(/^Save changes$/)!.click()
    await vi.waitFor(() => expect(sent('PATCH')).toHaveLength(1))
    expect(sent('PATCH')[0]).toMatchObject({ path: '/api/groups/1/calendars/10' })
    await vi.waitFor(() =>
      expect(text(document.querySelector('[data-group-calendar]'))).toContain('Rota'),
    )
    expect(document.body.textContent).toContain('Rota was saved.')
  })

  it('shares a calendar and sends the complete list without the owner', async () => {
    await mountGroup(1)
    button(/^Share Team calendar$/)!.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    // The owning group is listed as fixed: no remove button for it.
    expect(text(dialog())).toContain('cannot be changed here')
    expect(button(/^Stop sharing with staff$/)).toBeUndefined()
    dialogButton('Save sharing')!.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]!.body).toEqual({ shares: [] })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Sharing of Team calendar was saved.'),
    )
  })

  describe('for an admin', () => {
    beforeEach(() => {
      admin = true
      details = { 1: detailOf(1), 2: detailOf(2) }
    })

    it('names and removes a manager at once, from the row of a member', async () => {
      manages = false
      details = { 1: detailOf(1), 2: detailOf(2) }
      await mountGroup(1)
      button(/^Make manager of staff: Me \(me\)$/)!.click()
      await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
      expect(sent('PUT')[0]).toMatchObject({
        path: '/api/groups/1/managers',
        body: { managers: ['sub-me'] },
      })
      await vi.waitFor(() =>
        expect(button(/^Remove as manager of staff: Me \(me\)$/)).toBeDefined(),
      )
      expect(text(document.querySelector('[data-group-member]'))).toContain('Manager')
      expect(document.body.textContent).toContain('Me (me) manages staff now.')
      button(/^Remove as manager of staff: Me \(me\)$/)!.click()
      await vi.waitFor(() => expect(sent('PUT')).toHaveLength(2))
      expect(sent('PUT')[1]).toMatchObject({ body: { managers: [] } })
      await vi.waitFor(() =>
        expect(button(/^Make manager of staff: Me \(me\)$/)?.disabled).toBe(false),
      )
    })

    it('adds a member at once, with the saved list and the one person', async () => {
      await mountGroup(1)
      expect(button(/^Save members$/)).toBeUndefined()
      document.querySelector<HTMLElement>('form button[aria-haspopup="listbox"]')!.click()
      await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
      const anna = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
        text(item)?.startsWith('Anna'),
      )!
      anna.click()
      await vi.waitFor(() => expect(button(/^Add$/)?.disabled).toBe(false))
      button(/^Add$/)!.click()
      await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
      expect(sent('PUT')[0]).toMatchObject({
        path: '/api/groups/1/members',
        body: { members: ['sub-me', 'sub-anna'] },
      })
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-group-member]')).toHaveLength(2),
      )
      expect(document.body.textContent).toContain('Anna (anna) was added to staff.')
      expect(text(document.querySelector('[data-group-summary]'))).toContain('2 members')
    })

    it('removes a member only after asking, and keeps them when it is cancelled', async () => {
      await mountGroup(1)
      button(/^Remove Me \(me\) from staff$/)!.click()
      await vi.waitFor(() => expect(text(dialog())).toContain('Remove Me (me) from staff?'))
      dialogButton('Cancel')!.click()
      await vi.waitFor(() => expect(dialog()).toBeNull())
      expect(sent('PUT')).toHaveLength(0)

      button(/^Remove Me \(me\) from staff$/)!.click()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      dialogButton('Remove')!.click()
      await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
      expect(sent('PUT')[0]).toMatchObject({ path: '/api/groups/1/members', body: { members: [] } })
      await vi.waitFor(() => expect(document.querySelector('[data-members-none]')).not.toBeNull())
      expect(document.body.textContent).toContain('Me (me) was removed from staff.')
    })

    it('keeps the dialog open with the reason when the removal is refused', async () => {
      membersFailure = httpError(409, 'Only an admin may do that.', 'manager')
      await mountGroup(1)
      button(/^Remove Me \(me\) from staff$/)!.click()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      dialogButton('Remove')!.click()
      await vi.waitFor(() =>
        expect(text(dialog()?.querySelector('[role="alert"]'))).toContain(
          'Only an administrator can remove a manager of the group.',
        ),
      )
      expect(document.querySelectorAll('[data-group-member]')).toHaveLength(1)
    })

    it('shows imported groups as read-only, with the marker', async () => {
      await mountGroup(2)
      expect(document.querySelector('[data-imported-note]')).not.toBeNull()
      expect(button(/^Remove /)).toBeUndefined()
      expect(button(/^Add$/)).toBeUndefined()
    })

    it('shows the group of everyone with a note, its count, no member list and no way to change it', async () => {
      groups.push({
        id: 3,
        name: 'web_calendar_users',
        source: 'everyone',
        memberCount: 5,
        member: true,
        manager: false,
      })
      details[3] = detailOf(3)
      await mountGroup(3, 'web_calendar_users')
      expect(text(document.querySelector('[data-group-summary]'))).toBe('Built in · 5 members')
      expect(document.querySelector('[data-everyone-note]')).not.toBeNull()
      expect(document.querySelector('[data-imported-note]')).toBeNull()
      expect(document.querySelector('[data-members-none]')).toBeNull()
      expect(document.querySelector('[data-group-member]')).toBeNull()
      expect(button(/^Add$/)).toBeUndefined()
    })
  })
})

describe('groups from the identity provider', () => {
  const section = () => document.querySelector('[data-oidc-groups]')
  const candidateRows = () =>
    [...document.querySelectorAll('[data-oidc-group]')].map((li) => text(li))

  it('is not on the page for a member, and the list is never asked for', async () => {
    await mountList()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    expect(section()).toBeNull()
    expect(calls.some((call) => call.path.startsWith('/api/groups/oidc'))).toBe(false)
  })

  describe('for an admin', () => {
    beforeEach(() => {
      admin = true
    })

    it('lists the candidates with their state, and why one cannot be imported', async () => {
      await mountList()
      await vi.waitFor(() => expect(candidateRows()).toHaveLength(4))
      const list = candidateRows()
      expect(list[0]).toContain('ops')
      expect(list[0]).toContain('Not imported')
      expect(list[1]).toContain('Imported · 2 members')
      expect(list[2]).toContain('A group here has this name already.')
      expect(list[3]).toContain('has to be renamed there first')
      expect(button(/^Import ops$/)!.disabled).toBe(false)
      expect(button(/^Import Staff$/)!.disabled).toBe(true)
      expect(button(/^Import twin$/)!.disabled).toBe(true)
      expect(button(/^Stop importing it$/)).toBeDefined()
      expect(button(/^Import it$/)).toBeUndefined()
    })

    it('says when nothing has been seen yet', async () => {
      candidateList = []
      await mountList()
      await vi.waitFor(() => expect(document.querySelector('[data-oidc-none]')).not.toBeNull())
    })

    it('imports a group: sends the key, adds it to the groups and marks it imported', async () => {
      await mountList()
      await vi.waitFor(() => expect(candidateRows()).toHaveLength(4))
      button(/^Import ops$/)!.click()
      await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
      expect(sent('POST')[0]).toMatchObject({
        path: '/api/groups/oidc',
        body: { externalId: 'k-ops' },
      })
      await vi.waitFor(() => expect(candidateRows()[0]).toContain('Imported · 0 members'))
      expect(rows().join(' ')).toContain('ops')
      expect(document.body.textContent).toContain('ops was imported')
      expect(button(/^Stop importing ops$/)).toBeDefined()
    })

    it('shows a failed import at its row, not above the list', async () => {
      importFailure = httpError(409, 'A group with this name already exists.')
      await mountList()
      await vi.waitFor(() => expect(candidateRows()).toHaveLength(4))
      button(/^Import ops$/)!.click()
      await vi.waitFor(() =>
        expect(text(document.querySelector('[data-oidc-group] [role="alert"]'))).toContain(
          'A group with this name already exists.',
        ),
      )
      expect(candidateRows()[0]).toContain('Not imported')
      // Nothing above the list of groups.
      const list = document.querySelector('ul[aria-label="Groups"]')!
      const before = [...document.querySelectorAll('[role="alert"]')].filter(
        (alert) => list.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_PRECEDING,
      )
      expect(before).toHaveLength(0)
    })

    it('asks before it stops importing, and sends nothing when cancelled', async () => {
      await mountList()
      await vi.waitFor(() => expect(candidateRows()).toHaveLength(4))
      button(/^Stop importing it$/)!.click()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      expect(text(dialog())).toContain('Stop importing it?')
      button(/^Cancel$/)!.click()
      await vi.waitFor(() => expect(dialog()).toBeNull())
      expect(sent('DELETE')).toHaveLength(0)
    })

    it('stops importing after the confirmation: the group goes, the candidate stays', async () => {
      await mountList()
      await vi.waitFor(() => expect(rows()).toHaveLength(2))
      button(/^Stop importing it$/)!.click()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      dialogButton('Stop importing')!.click()
      await vi.waitFor(() => expect(sent('DELETE')).toHaveLength(1))
      expect(sent('DELETE')[0]!.path).toBe('/api/groups/oidc/2')
      await vi.waitFor(() => expect(rows()).toHaveLength(1))
      expect(candidateRows()[1]).toContain('Not imported')
      expect(button(/^Import it$/)).toBeDefined()
    })

    it('shows the server’s words in the dialog when stopping is refused, and keeps the group', async () => {
      stopFailure = Object.assign(new Error('conflict'), {
        statusCode: 409,
        data: {
          code: 'has_calendars',
          message: 'The group still owns calendars; delete them first',
        },
      })
      await mountList()
      await vi.waitFor(() => expect(rows()).toHaveLength(2))
      button(/^Stop importing it$/)!.click()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      dialogButton('Stop importing')!.click()
      await vi.waitFor(() => expect(text(dialog())).toContain('still owns calendars'))
      expect(rows()).toHaveLength(2)
      expect(candidateRows()[1]).toContain('Imported')
    })
  })
})
