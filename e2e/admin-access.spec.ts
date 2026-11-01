import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { TODAY, press } from './helpers'

// The access administration page (FR-14). The app runs in demo mode here, which serves the SPA
// without a login; `/api/me` and `/api/admin/access/**` are answered by a small stateful stand-in
// for the real routes (server/api/admin/access/**, me.get.ts). The menu entry is hidden in demo
// mode, so the page is opened by its address.

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
  private nextId = 10

  constructor(readonly admin: boolean) {}

  private calendar() {
    return {
      id: 5,
      name: 'Team',
      kind: 'shared',
      color: null,
      owner: null,
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
    if (!path.startsWith('/api/admin/access/')) return route.fallback()
    const raw = request.postData()
    const body: unknown = raw ? JSON.parse(raw) : undefined
    this.calls.push({ method, path, body })
    if (path === '/api/admin/access/calendars' && method === 'GET') {
      return route.fulfill({ json: { calendars: [this.calendar()], groupsAvailable: true } })
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
    return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
  }
}

async function openPage(page: Page, admin = true) {
  const api = new MockAccess(admin)
  const errors: string[] = []
  const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/
  page.on('pageerror', (error) => {
    if (!benign.test(error.message)) errors.push(error.message)
  })
  await page.route('**/api/**', (route) => api.handle(route))
  await page.clock.setFixedTime(TODAY)
  await page.goto('/admin/access')
  return { api, errors }
}

const rule = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Access rules of Team' }).getByRole('listitem').filter({
    hasText: name,
  })

test.describe('calendar access', () => {
  test('sends somebody who is not an admin back to the calendar', async ({ page }) => {
    const { api } = await openPage(page, false)
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(api.calls).toEqual([])
  })

  test('lists the rules with who, what and whether they are applied', async ({ page }) => {
    await openPage(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar access' })).toBeVisible()
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

  test('fits the screen and has 44 px controls', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main.main-area')!
      return main.scrollWidth - main.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(0)
    for (const name of ['Remove Bob Builder from Team', 'Add access']) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('has no accessibility violations', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
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
    await expect(page.getByRole('menuitem', { name: 'Calendar access' })).toHaveCount(0)
  })
})
