import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { TODAY, press } from './helpers'

// Admin › Calendars (FR-14). The app runs in demo mode here, which serves the SPA without a login;
// `/api/me` and `/api/admin/access/**` are answered by a small stateful stand-in for the real routes
// (server/api/admin/access/**, me.get.ts), the links of the calendar included. The menu entry is
// hidden in demo mode, so the page is opened by its old address, /admin/access, which still leads
// there; most tests open the Team calendar's dialog on "Who has access".

interface MockRule {
  id: number
  principalType: 'user' | 'group' | 'authenticated'
  principal: string | null
  label: string
  permission: 'free_busy' | 'read' | 'write'
  applied: boolean
  appliedAt: string | null
}

const BOB = '11111111-1111-4111-8111-111111111111'

interface MockLink {
  id: number
  label: string
  calendarName: string
  calendarColor: string | null
  calendarId: number
  level: 'read' | 'free_busy'
  readsAs: 'maker' | 'owner'
  maker: string
  createdAt: string
  lastUsedAt: string | null
  slug: string | null
}

const FRONT_DESK_SLUG = 'F'.repeat(43)
const FRONT_DESK_PASSWORD = 'front desk secret'

class MockAccess {
  calls: { method: string; path: string; body: unknown }[] = []
  rules: MockRule[] = [
    {
      id: 1,
      principalType: 'user',
      principal: BOB,
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
  ]
  links: MockLink[] = [
    {
      id: 3,
      label: 'Front desk',
      calendarName: 'Team',
      calendarColor: null,
      calendarId: 5,
      level: 'free_busy',
      readsAs: 'maker',
      maker: 'Bob Builder',
      createdAt: '2026-11-01T10:00:00.000Z',
      lastUsedAt: null,
      slug: FRONT_DESK_SLUG,
    },
  ]
  passwords = new Map<number, string>([[3, FRONT_DESK_PASSWORD]])
  name = 'Team'
  deleted = false
  private nextId = 10

  constructor(readonly admin: boolean) {}

  private calendar() {
    return {
      id: 5,
      name: this.name,
      kind: 'shared',
      color: null,
      owner: null,
      group: null,
      rules: this.rules,
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
          sub: 'sub-alice',
          username: 'alice',
          name: 'Alice Example',
          email: null,
          isAdmin: this.admin,
          timeZone: null,
        },
      })
    }
    if (path === '/api/groups') {
      return route.fulfill({
        json: {
          groups: [
            { id: 1, name: 'staff', source: 'app', memberCount: 3, member: true },
            { id: 2, name: 'parents', source: 'app', memberCount: 12, member: false },
          ],
        },
      })
    }
    if (!path.startsWith('/api/admin/access/')) return route.fallback()
    const raw = request.postData()
    const body: unknown = raw ? JSON.parse(raw) : undefined
    this.calls.push({ method, path, body })
    if (path === '/api/admin/access/calendars' && method === 'GET') {
      return route.fulfill({ json: { calendars: this.deleted ? [] : [this.calendar()] } })
    }
    if (path === '/api/admin/access/calendars/5' && method === 'PATCH') {
      this.name = (body as { name: string }).name
      return route.fulfill({ json: { calendar: this.calendar() } })
    }
    if (path === '/api/admin/access/calendars/5' && method === 'DELETE') {
      this.deleted = true
      return route.fulfill({ json: {} })
    }
    if (path === '/api/admin/access/users') {
      return route.fulfill({
        json: { users: [{ sub: BOB, name: 'Bob Builder', username: 'bob' }] },
      })
    }
    if (path === '/api/admin/access/calendars/5' && method === 'PUT') {
      const sent = (body as { rules: Omit<MockRule, 'id' | 'label' | 'applied' | 'appliedAt'>[] })
        .rules
      this.rules = sent.map((rule) => {
        const same = this.rules.find(
          (old) => old.principalType === rule.principalType && old.principal === rule.principal,
        )
        return same && same.permission === rule.permission
          ? same
          : {
              ...rule,
              id: this.nextId++,
              label: rule.principal ?? 'Everyone signed in',
              applied: false,
              appliedAt: null,
            }
      })
      return route.fulfill({ json: { changed: true, calendar: this.calendar() } })
    }
    if (path === '/api/admin/access/calendars/5/links' && method === 'GET') {
      return route.fulfill({ json: { links: this.links } })
    }
    if (path === '/api/admin/access/calendars/5/links' && method === 'POST') {
      const sent = body as { label?: string; level: 'read' | 'free_busy'; password: string }
      const link: MockLink = {
        id: this.nextId++,
        label: sent.label ?? 'Team',
        calendarName: 'Team',
        calendarColor: null,
        calendarId: 5,
        level: sent.level,
        readsAs: 'owner',
        maker: 'Alice Example',
        createdAt: '2026-11-05T10:00:00.000Z',
        lastUsedAt: null,
        slug: 'N'.repeat(43),
      }
      this.links = [link, ...this.links]
      this.passwords.set(link.id, sent.password)
      return route.fulfill({ status: 201, json: { link } })
    }
    const linkMatch = /^\/api\/admin\/access\/links\/(\d+)(\/reveal)?$/.exec(path)
    if (linkMatch) {
      const id = Number(linkMatch[1])
      const known = this.links.find((link) => link.id === id)
      if (!known) return route.fulfill({ status: 404, json: { statusCode: 404 } })
      if (linkMatch[2] && method === 'POST') {
        return route.fulfill({ json: { password: this.passwords.get(id) } })
      }
      if (!linkMatch[2] && method === 'DELETE') {
        this.links = this.links.filter((link) => link.id !== id)
        return route.fulfill({ json: { removed: { id } } })
      }
    }
    return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
  }
}

async function openPage(page: Page, admin = true, openAccess = true) {
  const api = new MockAccess(admin)
  const errors: string[] = []
  const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/
  page.on('pageerror', (error) => {
    if (!benign.test(error.message)) errors.push(error.message)
  })
  await page.route('**/api/**', (route) => api.handle(route))
  await page.clock.setFixedTime(TODAY)
  await page.goto('/admin/access')
  if (admin && openAccess) {
    await press(page.getByRole('button', { name: 'Access for Team' }))
    await expect(page.getByRole('dialog', { name: 'Team' })).toBeVisible()
  }
  return { api, errors }
}

const link = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Links' }).getByRole('listitem').filter({ hasText: name })

const reveals = (api: MockAccess) => api.calls.filter((call) => call.path.endsWith('/reveal'))

const rule = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Access rules of Team' }).getByRole('listitem').filter({
    hasText: name,
  })

test.describe('admin calendars', () => {
  test('sends somebody who is not an admin back to the calendar', async ({ page }) => {
    const { api } = await openPage(page, false)
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(api.calls).toEqual([])
  })

  test('lists the calendars, renames one and deletes it after asking', async ({ page }) => {
    const { api, errors } = await openPage(page, true, false)
    await expect(page).toHaveURL(/\/admin\/access$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Calendars' })).toBeVisible()
    const row = page.locator('[data-admin-calendar]')
    await expect(row).toContainText('Calendar of the organization · 2 access rules')
    await press(page.getByRole('button', { name: 'Edit Team' }))
    const dialog = page.getByRole('dialog', { name: 'Team' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Front office')
    await press(dialog.getByRole('button', { name: 'Save changes' }))
    await expect(row).toContainText('Front office')
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Front office',
      color: null,
    })
    await press(page.getByRole('button', { name: 'Delete calendar' }))
    const confirm = page.getByRole('dialog', { name: 'Delete "Front office"?' })
    await expect(confirm).toContainText('deleted for everybody who has it')
    await press(confirm.getByRole('button', { name: 'Delete' }))
    await expect(row).toHaveCount(0)
    await expect(page.getByText('There are no calendars to manage yet.')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('lists the rules with who, what and whether they are applied', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'Bob Builder')).toContainText('Can view')
    await expect(rule(page, 'Bob Builder')).toContainText('Applied')
    await expect(rule(page, 'staff')).toContainText('Can edit')
    await expect(rule(page, 'staff')).toContainText('Pending')
  })

  test('removes a rule', async ({ page }) => {
    const { api } = await openPage(page)
    await expect(rule(page, 'Bob Builder')).toBeVisible()
    await press(page.getByRole('button', { name: 'Remove Bob Builder from Team' }))
    await expect(rule(page, 'Bob Builder')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'no longer has access' })).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
  })

  test('adds access for a group chosen from the groups of the Groups page', async ({ page }) => {
    const { api } = await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    await press(page.getByRole('radio', { name: 'A group' }))
    await press(page.getByRole('button', { name: 'Add access' }))
    await expect(page.getByText('Choose a group.')).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'PUT')).toEqual([])

    await press(page.getByRole('button', { name: /^Group/ }))
    await page.getByLabel('Search groups').fill('par')
    await expect(page.getByRole('option')).toHaveText(['parents'])
    await press(page.getByRole('option', { name: 'parents' }))
    await press(page.getByRole('button', { name: 'Add access' }))
    await expect(rule(page, 'parents')).toContainText('Can view')
    const put = api.calls.find((call) => call.method === 'PUT')
    expect(put?.body).toMatchObject({
      rules: expect.arrayContaining([
        { principalType: 'group', principal: 'parents', permission: 'read' },
      ]),
    })
  })

  test('adds access for everyone signed in, pending until applied', async ({ page }) => {
    const { api } = await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    await press(page.getByRole('radio', { name: 'Everyone signed in' }))
    await press(page.getByRole('radio', { name: /^Busy times only/ }))
    await press(page.getByRole('button', { name: 'Add access' }))
    await expect(rule(page, 'Everyone signed in')).toContainText('Busy times only')
    await expect(rule(page, 'Everyone signed in')).toContainText('Pending')
    const put = api.calls.find((call) => call.method === 'PUT')
    expect(put?.body).toMatchObject({
      rules: expect.arrayContaining([
        { principalType: 'authenticated', principal: null, permission: 'free_busy' },
      ]),
    })
  })

  test('lists the links first, and shows a password only when asked, hiding it again', async ({
    page,
  }) => {
    const { api } = await openPage(page)
    const row = link(page, 'Front desk')
    await expect(row).toContainText('Busy times only · created by Bob Builder in Settings')
    // the links come before the people and groups
    const order = await page.evaluate(() => {
      const links = document.querySelector('[data-calendar-link]')!
      const rule = document.querySelector('[data-access-rule]')!
      return links.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING
    })
    expect(order).toBeTruthy()

    const details = page.getByRole('button', { name: 'Details of Front desk' })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await press(details)
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('textbox', { name: 'Address of Front desk' })).toHaveValue(
      new RegExp(`/link/${FRONT_DESK_SLUG}$`),
    )
    await expect(row).toContainText('Hidden')
    await expect(row).not.toContainText(FRONT_DESK_PASSWORD)
    expect(reveals(api)).toEqual([])

    const show = page.getByRole('button', { name: 'Show the password of Front desk' })
    await expect(show).toHaveAttribute('aria-pressed', 'false')
    await press(show)
    await expect(page.getByRole('textbox', { name: 'Password of Front desk' })).toHaveValue(
      FRONT_DESK_PASSWORD,
    )
    await expect(show).toHaveAttribute('aria-pressed', 'true')
    expect(reveals(api)).toHaveLength(1)
    await press(show)
    await expect(page.getByRole('textbox', { name: 'Password of Front desk' })).toHaveCount(0)
    await expect(show).toHaveAttribute('aria-pressed', 'false')

    // copying works, or says how to copy by hand
    await press(page.getByRole('button', { name: 'Copy the address of Front desk' }))
    await expect(row.getByRole('status')).toHaveText(/Copied to the clipboard|press Ctrl\+C/)
  })

  test('creates a link with a level and a password, and shows it with the password hidden', async ({
    page,
  }) => {
    const { api } = await openPage(page)
    await expect(link(page, 'Front desk')).toBeVisible()
    await press(page.getByRole('button', { name: 'Create link' }))
    const form = page.getByRole('form', { name: 'New link' })
    await expect(form.getByRole('textbox', { name: 'Label' })).toBeFocused()
    await form.getByRole('textbox', { name: 'Label' }).fill('For the parents')
    await press(form.getByRole('radio', { name: /^Busy times only/ }))
    await form.getByLabel(/^Password/).fill('short')
    await press(form.getByRole('button', { name: 'Create link' }))
    await expect(form).toContainText('Choose a password of at least 8 characters.')
    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([])

    await form.getByLabel(/^Password/).fill('correct horse')
    await press(form.getByRole('button', { name: 'Create link' }))
    await expect(form).toHaveCount(0)
    const row = link(page, 'For the parents')
    await expect(row).toContainText('Busy times only · created by Alice Example')
    await expect(row.getByText('For the parents', { exact: true })).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Address of For the parents' })).toHaveValue(
      /\/link\/N{43}$/,
    )
    await expect(row).toContainText('Hidden')
    const create = api.calls.find((call) => call.method === 'POST')
    expect(create?.body).toEqual({
      label: 'For the parents',
      level: 'free_busy',
      password: 'correct horse',
    })
    // the password just typed is shown without asking the server
    await press(page.getByRole('button', { name: 'Show the password of For the parents' }))
    await expect(page.getByRole('textbox', { name: 'Password of For the parents' })).toHaveValue(
      'correct horse',
    )
    expect(reveals(api)).toEqual([])
  })

  test('removes a link after asking', async ({ page }) => {
    const { api } = await openPage(page)
    await press(page.getByRole('button', { name: 'Remove link Front desk' }))
    const dialog = page.getByRole('dialog', { name: 'Remove the link “Front desk”?' })
    await press(dialog.getByRole('button', { name: 'Remove link' }))
    await expect(link(page, 'Front desk')).toHaveCount(0)
    await expect(page.getByText('There are no links to Team yet.')).toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'Link “Front desk” removed.' }),
    ).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
      '/api/admin/access/links/3',
    ])
  })

  test('fits the screen and has 44 px controls', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    await press(page.getByRole('button', { name: 'Details of Front desk' }))
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')!
      return dialog.scrollWidth - dialog.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(0)
    for (const name of [
      'Remove Bob Builder from Team',
      'Add access',
      'Create link',
      'Details of Front desk',
      'Copy the address of Front desk',
      'Show the password of Front desk',
      'Copy the password of Front desk',
      'Remove link Front desk',
    ]) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('has no accessibility violations', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    // with a link open, its password shown, and the form for a new link
    await press(page.getByRole('button', { name: 'Details of Front desk' }))
    await press(page.getByRole('button', { name: 'Show the password of Front desk' }))
    await expect(page.getByRole('textbox', { name: 'Password of Front desk' })).toBeVisible()
    await press(page.getByRole('button', { name: 'Create link' }))
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(violations.map((violation) => violation.id)).toEqual([])
  })

  test('is not offered in the menu in demo mode', async ({ page }) => {
    await openPage(page)
    await page.goto('/')
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await press(page.getByRole('button', { name: 'More options' }))
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Calendars' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'People' })).toHaveCount(0)
  })
})
