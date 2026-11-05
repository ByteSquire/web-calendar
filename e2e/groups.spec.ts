import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { TODAY, press } from './helpers'

// The groups page (/groups). The app runs in demo mode here, which serves the SPA without a login;
// `/api/**` is answered by a small stateful stand-in for the routes of server/api/groups/** and
// `/api/people`. The menu entry is hidden in demo mode, so the page is opened by its address.

interface MockShare {
  principalType: 'user' | 'group'
  principal: string
  label: string
  permission: 'read' | 'write'
}
interface MockCalendar {
  id: number
  name: string
  color: string | null
  shares: MockShare[]
}
interface MockGroup {
  id: number
  name: string
  source: 'app' | 'kanidm'
  members: { sub: string; name: string | null; username: string | null }[]
  calendars: MockCalendar[]
}

const PEOPLE = [
  { sub: 'sub-anna', name: 'Anna Berger', username: 'anna' },
  { sub: 'sub-bob', name: 'Bob Builder', username: 'bob' },
]

class MockGroups {
  calls: { method: string; path: string; body: unknown }[] = []
  /** Answers the next list requests with an error, then works again (ofetch retries a GET once). */
  failListRequests = 0
  groups: MockGroup[] = [
    {
      id: 1,
      name: 'staff',
      source: 'app',
      members: [{ sub: 'sub-me', name: 'Alice Example', username: 'alice' }],
      calendars: [
        {
          id: 10,
          name: 'Team',
          color: '#1d4ed8',
          shares: [
            { principalType: 'group', principal: 'staff', label: 'staff', permission: 'write' },
          ],
        },
      ],
    },
    {
      id: 2,
      name: 'it',
      source: 'kanidm',
      members: [{ sub: 'sub-bob', name: 'Bob Builder', username: 'bob' }],
      calendars: [],
    },
  ]
  private nextId = 20

  constructor(readonly admin: boolean) {}

  private summary(group: MockGroup) {
    return {
      id: group.id,
      name: group.name,
      source: group.source,
      memberCount: group.members.length,
      member: group.members.some((member) => member.sub === 'sub-me'),
    }
  }

  async handle(route: Route): Promise<void> {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === '/api/me') {
      return route.fulfill({
        json: {
          id: 1,
          sub: 'sub-me',
          username: 'alice',
          name: 'Alice Example',
          email: null,
          isAdmin: this.admin,
          timeZone: null,
        },
      })
    }
    if (path === '/api/people') return route.fulfill({ json: { people: PEOPLE } })
    if (!path.startsWith('/api/groups')) return route.fallback()
    const raw = request.postData()
    const body: unknown = raw ? JSON.parse(raw) : undefined
    this.calls.push({ method, path, body })

    if (path === '/api/groups' && method === 'GET') {
      if (this.failListRequests > 0) {
        this.failListRequests -= 1
        return route.fulfill({ status: 500, json: { statusCode: 500, message: 'Boom' } })
      }
      return route.fulfill({ json: { groups: this.groups.map((group) => this.summary(group)) } })
    }
    if (path === '/api/groups' && method === 'POST') {
      const name = (body as { name: string }).name
      const created: MockGroup = {
        id: this.nextId++,
        name,
        source: 'app',
        members: [],
        calendars: [],
      }
      this.groups.push(created)
      return route.fulfill({ status: 201, json: { group: this.summary(created) } })
    }

    const match = /^\/api\/groups\/(\d+)(\/.*)?$/.exec(path)
    const group = this.groups.find((item) => item.id === Number(match?.[1]))
    if (!match || !group)
      return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
    const rest = match[2] ?? ''
    if (rest === '' && method === 'GET') {
      return route.fulfill({
        json: {
          id: group.id,
          name: group.name,
          source: group.source,
          canManageMembers: group.source === 'app' && this.admin,
          members: group.members,
          calendars: group.calendars,
        },
      })
    }
    if (rest === '' && method === 'DELETE') {
      if (group.calendars.length > 0) {
        return route.fulfill({
          status: 409,
          json: { statusCode: 409, message: 'The group still owns calendars.' },
        })
      }
      this.groups = this.groups.filter((item) => item.id !== group.id)
      return route.fulfill({ json: {} })
    }
    if (rest === '/members' && method === 'PUT') {
      group.members = (body as { members: string[] }).members.map((sub) =>
        PEOPLE.find((person) => person.sub === sub)!,
      )
      return route.fulfill({ json: { members: group.members } })
    }
    if (rest === '/calendars' && method === 'POST') {
      const input = body as { name: string; color?: string }
      const created: MockCalendar = {
        id: this.nextId++,
        name: input.name,
        color: input.color ?? null,
        shares: [
          { principalType: 'group', principal: group.name, label: group.name, permission: 'write' },
        ],
      }
      group.calendars.push(created)
      return route.fulfill({ status: 201, json: { calendar: created } })
    }
    const calendarMatch = /^\/calendars\/(\d+)(\/shares)?$/.exec(rest)
    const calendar = group.calendars.find((item) => item.id === Number(calendarMatch?.[1]))
    if (calendarMatch && calendar) {
      if (calendarMatch[2] === '/shares' && method === 'PUT') {
        const shares = (
          body as {
            shares: {
              principalType: 'user' | 'group'
              principal: string
              permission: 'read' | 'write'
            }[]
          }
        ).shares
        const owner = calendar.shares.filter((share) => share.principal === group.name)
        calendar.shares = [
          ...owner,
          ...shares.map((share) => ({
            ...share,
            label:
              share.principalType === 'user'
                ? (PEOPLE.find((person) => person.sub === share.principal)?.name ?? share.principal)
                : share.principal,
          })),
        ]
        return route.fulfill({ json: { calendar } })
      }
      if (calendarMatch[2] === undefined && method === 'PATCH') {
        const input = body as { name?: string; color?: string | null }
        if (input.name !== undefined) calendar.name = input.name
        if (input.color !== undefined) calendar.color = input.color
        return route.fulfill({ json: { calendar } })
      }
      if (calendarMatch[2] === undefined && method === 'DELETE') {
        group.calendars = group.calendars.filter((item) => item.id !== calendar.id)
        return route.fulfill({ json: {} })
      }
    }
    return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
  }
}

async function openPage(page: Page, admin: boolean, failFirstList = false) {
  const api = new MockGroups(admin)
  api.failListRequests = failFirstList ? 2 : 0
  await page.route('**/api/**', (route) => api.handle(route))
  await page.clock.setFixedTime(TODAY)
  await page.goto('/groups')
  // The title is German for a German browser: wait for the heading whatever the language.
  await expect(page.locator('h1')).toBeVisible()
  return api
}

const groupRow = (page: Page, name: string) =>
  page.locator('[data-group]').filter({ has: page.getByText(name, { exact: true }) })

async function openGroup(page: Page, name: string) {
  await press(page.getByRole('button', { name: `Open ${name}` }))
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
}

/** Chooses an option of a select menu: its trigger is a button named after the label. */
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click()
  await page.getByRole('option', { name: option }).click()
}

test.describe('groups for a member', () => {
  test('sees the groups, creates, renames and deletes a calendar', async ({ page }) => {
    const api = await openPage(page, false)
    // The server lists "it" too (the share dialog offers it), but the member is not in it.
    await expect(page.locator('[data-group]')).toHaveCount(1)
    await expect(groupRow(page, 'staff')).toContainText('Created in this app')
    await expect(page.getByRole('button', { name: 'Open it' })).toHaveCount(0)
    // Members do not see the admin controls.
    await expect(page.getByRole('button', { name: 'Create group' })).toHaveCount(0)

    await openGroup(page, 'staff')
    const calendars = page.locator('[data-group-calendar]')
    await expect(calendars).toHaveCount(1)

    const create = page.locator('form').filter({ hasText: 'New calendar' })
    await create.getByLabel('Name').fill('Kitchen')
    await page.getByRole('button', { name: 'Add calendar' }).click()
    await expect(calendars).toHaveCount(2)
    expect(
      api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/calendars'))?.body,
    ).toEqual({
      name: 'Kitchen',
      color: '#1d4ed8',
    })

    await press(page.getByRole('button', { name: 'Edit Kitchen' }))
    await page
      .locator('form')
      .filter({ hasText: 'Edit calendar' })
      .getByLabel('Name')
      .fill('Kitchen plan')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Kitchen plan', { exact: true })).toBeVisible()

    await press(page.getByRole('button', { name: 'Delete Kitchen plan' }))
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(calendars).toHaveCount(1)
    await expect(page.getByRole('status').filter({ hasText: 'deleted' }).first()).toContainText(
      'Kitchen plan was deleted.',
    )
  })

  test('shares a calendar with a person to read and with a group to edit', async ({ page }) => {
    const api = await openPage(page, false)
    await openGroup(page, 'staff')
    await press(page.getByRole('button', { name: 'Share Team' }))
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('cannot be changed here')
    await expect(page.getByRole('button', { name: 'Stop sharing with staff' })).toHaveCount(0)

    await choose(page, 'Person', 'Anna Berger (anna)')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await press(dialog.getByRole('radio', { name: 'A group' }))
    await choose(page, 'Group', 'it')
    await dialog.getByRole('radio', { name: 'Can edit' }).check({ force: true })
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await dialog.getByRole('button', { name: 'Save sharing' }).click()
    await expect(dialog).toBeHidden()
    const put = api.calls.find((call) => call.method === 'PUT')
    expect(put?.body).toEqual({
      shares: [
        { principalType: 'user', principal: 'sub-anna', permission: 'read' },
        { principalType: 'group', principal: 'it', permission: 'write' },
      ],
    })
  })

  test('shows the error of the list and loads it again on retry', async ({ page }) => {
    await openPage(page, false, true)
    await expect(
      page.getByRole('alert').filter({ hasText: 'Could not load the groups' }),
    ).toBeVisible()
    await press(page.getByRole('button', { name: 'Retry' }))
    await expect(page.locator('[data-group]')).toHaveCount(1)
  })
})

test.describe('groups for an admin', () => {
  test('creates a group and edits its members as one list', async ({ page }) => {
    const api = await openPage(page, true)
    await page.getByLabel('Group name').fill('kitchen-crew')
    await page.getByRole('button', { name: 'Create group' }).click()
    await expect(groupRow(page, 'kitchen-crew')).toBeVisible()

    await openGroup(page, 'kitchen-crew')
    const members = page.locator('form').filter({ hasText: 'Add a member' })
    await choose(page, 'Person', 'Bob Builder (bob)')
    await members.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Save members' }).click()
    await expect(page.getByRole('button', { name: 'Save members' })).toHaveCount(0)
    expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({ members: ['sub-bob'] })
  })

  test('refuses a name that breaks the rules before sending it', async ({ page }) => {
    const api = await openPage(page, true)
    await page.getByLabel('Group name').fill('-kitchen')
    await page.getByRole('button', { name: 'Create group' }).click()
    await expect(page.getByText('Start with a letter or a digit.')).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  test('shows the imported group read-only, without member controls', async ({ page }) => {
    await openPage(page, true)
    await openGroup(page, 'it')
    await expect(page.getByText('This group is imported from Kanidm.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save members' })).toHaveCount(0)
  })

  test('shows the reason when a group with calendars cannot be deleted', async ({ page }) => {
    await openPage(page, true)
    await press(page.getByRole('button', { name: 'Delete group staff' }))
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('cannot be deleted')
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(dialog.getByRole('alert')).toContainText('The group still owns calendars.')
    await expect(page.locator('[data-group]').filter({ hasText: 'staff' })).toHaveCount(1)
  })
})

test.describe('keyboard and German', () => {
  test('opens a group by keyboard and returns focus to the share button after Escape', async ({
    page,
  }) => {
    await openPage(page, false)
    await page.getByRole('button', { name: 'Open staff' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'staff', level: 2 })).toBeVisible()
    await page.getByRole('button', { name: 'Share Team' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Share Team' })).toBeFocused()
  })

  test.describe('in German', () => {
    test.use({ locale: 'de-DE' })

    test('shows the page in German', async ({ page }) => {
      await openPage(page, true)
      await expect(page.getByRole('heading', { name: 'Gruppen', level: 1 })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Gruppe anlegen' })).toBeVisible()
      await expect(page.getByText('Create group')).toHaveCount(0)
    })
  })

  test('has no accessibility violations on the open group', async ({ page }) => {
    await openPage(page, true)
    await openGroup(page, 'staff')
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(violations.map((violation) => violation.id)).toEqual([])
  })
})
