// @vitest-environment nuxt
// The groups page inside a real Nuxt UI app, with a fake API behind `useAuthFetch`: what a member
// and an admin see, what a calendar change sends, the imported group that is read-only, and the
// retry after a failed list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import GroupsPage from '~/pages/groups.vue'
import type { GroupDetail, GroupSummary, OidcCandidate } from '~/utils/groups/model'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(GroupsPage) }) })

const ME = { id: 1, sub: 'sub-me', username: 'me', name: 'Me', email: null, timeZone: null }
const PEOPLE = [
  { sub: 'sub-anna', name: 'Anna', username: 'anna' },
  { sub: 'sub-bob', name: 'Bob', username: 'bob' },
]

let admin = false
let groups: GroupSummary[]
let details: Record<number, GroupDetail>
let failGroups = false
let candidateList: OidcCandidate[]
let stopFailure: unknown = null
const calls: { path: string; method: string; body: unknown }[] = []
let app: Awaited<ReturnType<typeof mountSuspended>>

const start = (): GroupSummary[] => [
  { id: 1, name: 'staff', source: 'app', memberCount: 1, member: true },
  { id: 2, name: 'it', source: 'oidc', memberCount: 2, member: true },
]

function detailOf(id: number): GroupDetail {
  return {
    id,
    name: id === 1 ? 'staff' : id === 2 ? 'it' : 'web_calendar_users',
    source: id === 1 ? 'app' : id === 2 ? 'oidc' : 'everyone',
    canManageMembers: id === 1 && admin,
    members: id === 1 ? [{ sub: 'sub-me', name: 'Me', username: 'me' }] : [],
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

beforeEach(() => {
  admin = false
  failGroups = false
  stopFailure = null
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
    if (path === '/api/groups/oidc' && method === 'GET') {
      return { candidates: candidateList, truncated: false }
    }
    if (path === '/api/groups/oidc' && method === 'POST') {
      const { externalId } = options?.body as { externalId: string }
      const candidate = candidateList.find((item) => item.id === externalId)!
      return {
        group: { id: 7, name: candidate.name, source: 'oidc', memberCount: 0, member: false },
      }
    }
    const stop = /^\/api\/groups\/oidc\/(\d+)$/.exec(path)
    if (stop && method === 'DELETE') {
      if (stopFailure) throw stopFailure
      return { removed: { calendarRules: 1, resourceRules: 0 } }
    }
    const group = /^\/api\/groups\/(\d+)$/.exec(path)
    if (group && method === 'GET') return details[Number(group[1])]
    if (path === '/api/groups/1/calendars' && method === 'POST') {
      const body = options?.body as { name: string; color?: string }
      const created = { id: 11, name: body.name, color: body.color ?? null, shares: [] }
      details[1]!.calendars.push(created)
      return { calendar: created }
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
      const body = options?.body as { members: string[] }
      const members = body.members.map((sub) => PEOPLE.find((person) => person.sub === sub)!)
      details[1]!.members = members
      return { members }
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
const rows = () => [...document.querySelectorAll('[data-group]')].map((li) => text(li))
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''),
  )
const sent = (method: string) => calls.filter((call) => call.method === method)
const field = (label: string) =>
  [...document.querySelectorAll('label')].find((item) => text(item)?.startsWith(label))

async function openGroup(name: string) {
  button(new RegExp(`^Open ${name}$`))!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-group-calendar]')).not.toBeNull())
}

describe('for a member', () => {
  it('lists only the groups the person is in, and offers all of them to share with', async () => {
    groups = [...start(), { id: 3, name: 'board', source: 'app', memberCount: 4, member: false }]
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().join(' ')).not.toContain('board')
    expect(button(/^Open board$/)).toBeUndefined()
    // The share dialog is built from the full list.
    await openGroup('staff')
    button(/^Share Team calendar$/)!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]')]
    expect(radio.length).toBeGreaterThan(0)
  })

  it('says when the people offered are not everybody, and not otherwise', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await openGroup('staff')
    expect(document.body.textContent).not.toContain('Not everybody is offered')

    app.unmount()
    document.body.innerHTML = ''
    const handler = api.handler
    api.handler = (async (path: string, options?: { method?: string; body?: unknown }) =>
      path === '/api/people'
        ? { people: PEOPLE, truncated: true }
        : handler(path, options)) as Handler
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await openGroup('staff')
    expect(document.body.textContent).toContain(
      `Not everybody is offered when you add members or share: the list shows the first ${PEOPLE.length} people`,
    )
  })

  it('lists the groups with their source and member count', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]).toContain('staff')
    expect(rows()[0]).toContain('Created in this app')
    expect(rows()[1]).toContain('From your identity provider')
    expect(rows()[1]).toContain('2 members')
    // Only admins get the create form and the delete buttons.
    expect(document.querySelector('#group-create-heading')).toBeNull()
    expect(button(/^Delete group staff$/)).toBeUndefined()
  })

  it('opens a group with its calendars and creates one with a colour', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await openGroup('staff')
    expect(document.querySelector('[data-group-calendar]')?.textContent).toContain('Team calendar')
    // A member of a custom group who is not an admin does not manage the member list.
    expect(button(/^Remove /)).toBeUndefined()
    const nameInput = document.querySelector<HTMLInputElement>('[data-group-calendar]')
    expect(nameInput).not.toBeNull()
    const create = [...document.querySelectorAll('form')].find((form) =>
      text(form.querySelector('h4'))?.startsWith('New calendar'),
    )!
    const input = create.querySelector('input')!
    input.value = '  Kitchen plan '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    ;(create.querySelector('button[type="submit"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
    expect(sent('POST')[0]!.body).toEqual({ name: 'Kitchen plan', color: '#1d4ed8' })
  })

  it('shares a calendar with a read share and sends the complete list without the owner', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await openGroup('staff')
    button(/^Share Team calendar$/)!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    // The owning group is listed as fixed: no remove button for it.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'cannot be changed here',
    )
    expect(button(/^Stop sharing with staff$/)).toBeUndefined()
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (item) => /Save sharing/.test(item.textContent ?? ''),
    )!
    save.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]!.body).toEqual({ shares: [] })
  })

  it('shows the error of a list with a retry that loads it again', async () => {
    failGroups = true
    await mountPage()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not load the groups',
      ),
    )
    expect(rows()).toHaveLength(0)
    button(/^Retry$/)!.click()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
  })
})

describe('for an admin', () => {
  beforeEach(() => {
    admin = true
    details = { 1: detailOf(1), 2: detailOf(2) }
  })

  it('creates a custom group and shows the server message when the name is taken', async () => {
    api.handler = (async (path: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET'
      if (path === '/api/me') return { ...ME, isAdmin: true }
      if (path === '/api/people') return { people: PEOPLE }
      if (path === '/api/groups' && method === 'GET') return { groups }
      if (path === '/api/groups' && method === 'POST') {
        throw Object.assign(new Error('x'), {
          statusCode: 409,
          data: { statusCode: 409, message: 'A group with this name already exists.' },
        })
      }
      throw new Error(`unexpected ${method} ${path}`)
    }) as Handler
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    const input = field('Group name')
    expect(input).toBeDefined()
    const el = document.getElementById(input!.getAttribute('for')!) as HTMLInputElement
    el.value = 'staff'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    button(/^Create group$/)!.click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('A group with this name already exists.'),
    )
  })

  it('refuses a bad group name before sending anything', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    const el = document.getElementById(
      field('Group name')!.getAttribute('for')!,
    ) as HTMLInputElement
    el.value = '-bad'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    button(/^Create group$/)!.click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Start with a letter or a digit'),
    )
    expect(sent('POST')).toHaveLength(0)
  })

  it('edits the members of a custom group as one complete list', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await openGroup('staff')
    button(/^Remove Me \(me\) from staff$/)!.click()
    await vi.waitFor(() => expect(button(/^Save members$/)).toBeDefined())
    button(/^Undo changes$/)!.click()
    await vi.waitFor(() => expect(button(/^Save members$/)).toBeUndefined())
    expect(button(/^Remove Me \(me\) from staff$/)).toBeDefined()
    expect(sent('PUT')).toHaveLength(0)

    button(/^Remove Me \(me\) from staff$/)!.click()
    await vi.waitFor(() => expect(button(/^Save members$/)).toBeDefined())
    button(/^Save members$/)!.click()
    await vi.waitFor(() => expect(sent('PUT')).toHaveLength(1))
    expect(sent('PUT')[0]).toMatchObject({ path: '/api/groups/1/members', body: { members: [] } })
  })

  it('shows imported groups as read-only, with the marker', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await openGroup('it')
    expect(document.querySelector('[data-imported-note]')).not.toBeNull()
    expect(button(/^Remove /)).toBeUndefined()
    expect(button(/^Save members$/)).toBeUndefined()
  })

  it('shows the group of everyone with a note, no member list and no way to change it', async () => {
    groups.push({
      id: 3,
      name: 'web_calendar_users',
      source: 'everyone',
      memberCount: 5,
      member: true,
    })
    details[3] = detailOf(3)
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows()[2]).toContain('Built in')
    expect(rows()[2]).toContain('5 members')
    // It owns no calendars, so wait for its note instead of a calendar (as `openGroup` does).
    button(/^Open web_calendar_users$/)!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-everyone-note]')).not.toBeNull())
    expect(document.querySelector('[data-imported-note]')).toBeNull()
    expect(document.querySelector('[data-members-none]')).toBeNull()
    expect(document.querySelector('[data-group-member]')).toBeNull()
    expect(button(/^Save members$/)).toBeUndefined()
    expect(button(/^Add$/)).toBeUndefined()
  })
})

describe('groups from the identity provider', () => {
  const section = () => document.querySelector('[data-oidc-groups]')
  const candidateRows = () =>
    [...document.querySelectorAll('[data-oidc-group]')].map((li) => text(li))

  it('is not on the page for a member, and the list is never asked for', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    expect(section()).toBeNull()
    expect(calls.some((call) => call.path.startsWith('/api/groups/oidc'))).toBe(false)
  })

  describe('for an admin', () => {
    beforeEach(() => {
      admin = true
    })

    it('lists the candidates with their state, and why one cannot be imported', async () => {
      await mountPage()
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
      await mountPage()
      await vi.waitFor(() => expect(document.querySelector('[data-oidc-none]')).not.toBeNull())
    })

    it('imports a group: sends the key, adds it to the groups and marks it imported', async () => {
      await mountPage()
      await vi.waitFor(() => expect(candidateRows()).toHaveLength(4))
      button(/^Import ops$/)!.click()
      await vi.waitFor(() => expect(sent('POST')).toHaveLength(1))
      expect(sent('POST')[0]).toMatchObject({
        path: '/api/groups/oidc',
        body: { externalId: 'k-ops' },
      })
      await vi.waitFor(() => expect(candidateRows()[0]).toContain('Imported · 0 members'))
      expect(rows().join(' ')).toContain('ops')
      expect(document.querySelector('[role="status"]')?.textContent).toContain('ops was imported')
      expect(button(/^Stop importing ops$/)).toBeDefined()
    })

    it('asks before it stops importing, and sends nothing when cancelled', async () => {
      await mountPage()
      await vi.waitFor(() => expect(candidateRows()).toHaveLength(4))
      button(/^Stop importing it$/)!.click()
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
      expect(text(document.querySelector('[role="dialog"]'))).toContain('Stop importing it?')
      button(/^Cancel$/)!.click()
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
      expect(sent('DELETE')).toHaveLength(0)
    })

    it('stops importing after the confirmation: the group goes, the candidate stays', async () => {
      await mountPage()
      await vi.waitFor(() => expect(rows()).toHaveLength(2))
      button(/^Stop importing it$/)!.click()
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
      const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ].find((item) => text(item) === 'Stop importing')!
      confirm.click()
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
      await mountPage()
      await vi.waitFor(() => expect(rows()).toHaveLength(2))
      button(/^Stop importing it$/)!.click()
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
      ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((item) => text(item) === 'Stop importing')!
        .click()
      await vi.waitFor(() =>
        expect(text(document.querySelector('[role="dialog"]'))).toContain('still owns calendars'),
      )
      expect(rows()).toHaveLength(2)
      expect(candidateRows()[1]).toContain('Imported')
    })
  })
})
