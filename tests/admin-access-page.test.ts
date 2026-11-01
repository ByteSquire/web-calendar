// @vitest-environment nuxt
// The access administration page inside a real Nuxt UI app, with a fake API behind
// `useAuthFetch`: who is sent away, what is listed, and what an add or a remove sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import AccessPage from '~/pages/admin/access.vue'
import type { AccessCalendarsResponse } from '~/utils/admin/access'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(AccessPage) }) })

const ME = { id: 1, sub: 's', username: 'alice', name: 'Alice', email: null, timeZone: null }
const calendars = (groupsAvailable = true): AccessCalendarsResponse => ({
  groupsAvailable,
  calendars: [
    {
      id: 5,
      name: 'Team',
      kind: 'shared',
      color: null,
      owner: null,
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
    },
  ],
})

const calls: { path: string; method: string; body: unknown }[] = []
let admin = true
let groups = true
let saveFailure: unknown = null
let app: Awaited<ReturnType<typeof mountSuspended>>
let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  calls.length = 0
  admin = true
  groups = true
  saveFailure = null
  replace = vi.fn(async () => undefined)
  vi.spyOn(useRouter(), 'replace').mockImplementation(replace as never)
  api.handler = async (path, options) => {
    calls.push({ path, method: options?.method ?? 'GET', body: options?.body })
    if (path === '/api/me') return { ...ME, isAdmin: admin }
    if (path === '/api/admin/access/calendars' && !options?.method) return calendars(groups)
    if (path === '/api/admin/access/users')
      return { users: [{ sub: 'u-bob', name: 'Bob Builder', username: 'bob' }] }
    if (options?.method === 'PUT') {
      if (saveFailure) throw saveFailure
      const rules = (
        options.body as {
          rules: { principalType: string; principal: string | null; permission: string }[]
        }
      ).rules
      const base = calendars(groups).calendars[0]!
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
  it('lists the rules of the first calendar with who, what and whether they are applied', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rules()).toHaveLength(2))
    expect(document.querySelector('h1')?.textContent).toBe('Calendar access')
    expect(rules()[0]).toContain('Bob Builder')
    expect(rules()[0]).toContain('Can view')
    expect(rules()[0]).toContain('Applied')
    expect(rules()[1]).toContain('staff')
    expect(rules()[1]).toContain('Can edit')
    expect(rules()[1]).toContain('Pending')
    expect(text(document.body)).toContain('1 rule is pending')
  })

  it('removes a rule by sending the list without it', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rules()).toHaveLength(2))
    button(/^Remove Bob Builder from Team$/)!.click()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]).toMatchObject({
      path: '/api/admin/access/calendars/5',
      body: { rules: [{ principalType: 'group', principal: 'staff', permission: 'write' }] },
    })
    await vi.waitFor(() =>
      expect(text(document.querySelector('[role="status"][aria-live]'))).toContain(
        'no longer has access',
      ),
    )
  })

  it('adds a rule for everyone signed in at the chosen level', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rules()).toHaveLength(2))
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

  it('does not send a group name that cannot be one', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rules()).toHaveLength(2))
    radio('A group').click()
    await vi.waitFor(() =>
      expect(document.querySelector('input[autocapitalize="none"]')).not.toBeNull(),
    )
    const input = document.querySelector<HTMLInputElement>('input[autocapitalize="none"]')!
    input.value = 'bad/name'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    button(/^Add access$/)!.click()
    await vi.waitFor(() => expect(text(document.body)).toContain('Enter the group name'))
    expect(puts()).toHaveLength(0)
  })

  it('names the rule the server refused and keeps the list', async () => {
    saveFailure = {
      statusCode: 400,
      data: {
        statusCode: 400,
        message: 'The request is not valid',
        data: { fields: [{ field: 'rules[2].principal', message: 'is not a Kanidm group' }] },
      },
    }
    await mountPage()
    await vi.waitFor(() => expect(rules()).toHaveLength(2))
    radio('A group').click()
    await vi.waitFor(() =>
      expect(document.querySelector('input[autocapitalize="none"]')).not.toBeNull(),
    )
    const input = document.querySelector<HTMLInputElement>('input[autocapitalize="none"]')!
    input.value = 'nope'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    button(/^Add access$/)!.click()
    await vi.waitFor(() =>
      expect(text(document.querySelector('[role="alert"]'))).toContain(
        'Nothing was changed. Group nope is not a Kanidm group.',
      ),
    )
    expect(rules()).toHaveLength(2)
  })

  it('disables the group choice when the server cannot check groups', async () => {
    groups = false
    await mountPage()
    await vi.waitFor(() => expect(rules()).toHaveLength(2))
    expect(radio('A group').hasAttribute('disabled')).toBe(true)
    expect(text(document.body)).toContain('no Kanidm token')
  })
})
