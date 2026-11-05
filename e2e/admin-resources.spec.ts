import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { TODAY } from './helpers'

// The resources administration page. The app runs in demo mode here, which serves the SPA without
// a login; `/api/me` and `/api/admin/resources` are answered by a small stateful stand-in for the
// real routes (server/api/admin/resources/**). The menu entry is hidden in demo mode, so the page
// is opened by its address.

interface MockResource {
  id: number
  name: string
  type: string
  location: string | null
  capacity: number | null
  description: string | null
  active: boolean
}

class MockResources {
  calls: { method: string; path: string; body: unknown }[] = []
  resources: MockResource[] = [
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

  constructor(readonly admin: boolean) {}

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
    if (!path.startsWith('/api/admin/resources')) return route.fallback()
    const raw = request.postData()
    const body: unknown = raw ? JSON.parse(raw) : undefined
    this.calls.push({ method, path, body })
    if (path === '/api/admin/resources' && method === 'GET') {
      return route.fulfill({ json: { resources: this.resources } })
    }
    if (path === '/api/admin/resources' && method === 'POST') {
      const created = { id: 3, active: true, ...(body as object) } as MockResource
      this.resources.push(created)
      return route.fulfill({ status: 201, json: created })
    }
    const acl = /^\/api\/admin\/resources\/(\d+)\/acl$/.exec(path)
    if (acl && method === 'GET') {
      return route.fulfill({
        json: {
          rules: [
            { principalType: 'user', principal: 'u-bob', right: 'manage' },
            { principalType: 'authenticated', principal: null, right: 'book' },
          ],
        },
      })
    }
    const one = /^\/api\/admin\/resources\/(\d+)$/.exec(path)
    const target = this.resources.find((item) => item.id === Number(one?.[1]))
    if (target && method === 'PUT') {
      Object.assign(target, body)
      return route.fulfill({ json: target })
    }
    const deactivate = /^\/api\/admin\/resources\/(\d+)\/deactivate$/.exec(path)
    const found = this.resources.find((item) => item.id === Number(deactivate?.[1]))
    if (found && method === 'POST') {
      found.active = false
      return route.fulfill({ json: found })
    }
    return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
  }
}

/** The box of an element once it stops moving (a dialog scales in as it opens). */
async function settledBox(locator: Locator) {
  let last = await locator.boundingBox()
  for (let i = 0; i < 20; i += 1) {
    await locator.page().waitForTimeout(100)
    const next = await locator.boundingBox()
    if (next && last && next.x === last.x && next.width === last.width && next.y === last.y) {
      return next
    }
    last = next
  }
  return last
}

async function openPage(page: Page, admin = true) {
  const api = new MockResources(admin)
  await page.route('**/api/**', (route) => api.handle(route))
  await page.clock.setFixedTime(TODAY)
  await page.goto('/admin/resources')
  return api
}

test.describe('resources administration', () => {
  test('lists active and inactive resources and adds one', async ({ page }) => {
    const api = await openPage(page)
    await expect(page.getByRole('heading', { name: 'Resources', level: 1 })).toBeVisible()
    await expect(page.locator('[data-resource]')).toHaveCount(2)
    await expect(page.locator('[data-resource]').nth(1)).toContainText('Inactive')
    await page.getByRole('main').getByLabel('Name').fill('Projector')
    await page.getByRole('button', { name: 'Add resource' }).click()
    await expect(page.locator('[data-resource]')).toHaveCount(3)
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      name: 'Projector',
      type: 'room',
      capacity: null,
    })
  })

  test('deactivates a resource', async ({ page }) => {
    await openPage(page)
    await page.getByRole('button', { name: 'Deactivate Board room' }).click()
    await expect(page.locator('[data-resource]').first()).toContainText('Inactive')
  })

  test('edits a resource and its access in one dialog, with tabs to switch', async ({ page }) => {
    const api = await openPage(page)
    await page.getByRole('button', { name: 'Edit Board room' }).click()
    const dialog = page.getByRole('dialog', { name: 'Board room' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'Resource' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await dialog.getByLabel('Name').fill('Large room')
    // Switching to the access rules keeps the dialog and what was typed.
    await dialog.getByRole('tab', { name: 'Access' }).click()
    await expect(dialog.getByRole('tab', { name: 'Access' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(dialog.locator('[data-resource-rule]')).toHaveCount(2)
    await dialog.getByRole('tab', { name: 'Resource' }).click()
    await expect(dialog.getByLabel('Name')).toHaveValue('Large room')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    // Saved: the dialog closes, as the one of an event does, and the list shows the new name.
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-resource]').first()).toContainText('Large room')
    expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      name: 'Large room',
    })
  })

  test('"Access" opens the same dialog on the access tab, in the same place', async ({ page }) => {
    await openPage(page)
    await page.getByRole('button', { name: 'Edit Board room' }).click()
    const dialog = page.getByRole('dialog', { name: 'Board room' })
    const editBox = await settledBox(dialog)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Access for Board room' }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'Access' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(dialog.locator('[data-resource-rule]')).toHaveCount(2)
    const accessBox = await settledBox(dialog)
    // The same control, at the same left edge and top (its height follows its content).
    expect(Math.abs(accessBox!.x - editBox!.x)).toBeLessThan(2)
    expect(Math.abs(accessBox!.width - editBox!.width)).toBeLessThan(2)
  })

  test('has tabs of at least 44 px and no accessibility violations, on either tab', async ({
    page,
  }) => {
    await openPage(page)
    await page.getByRole('button', { name: 'Edit Board room' }).click()
    const dialog = page.getByRole('dialog', { name: 'Board room' })
    for (const name of ['Resource', 'Access']) {
      await dialog.getByRole('tab', { name }).click()
      const box = await dialog.getByRole('tab', { name }).boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(43.5)
      await expect(dialog.getByRole('tabpanel')).toBeVisible()
      // The colours of the tabs change with a short transition; the scan waits for its end.
      await page.waitForTimeout(500)
      const { violations } = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(violations.map((violation) => violation.id)).toEqual([])
    }
  })

  test('sends somebody who is not an admin back to the calendar', async ({ page }) => {
    await openPage(page, false)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
  })

  test('has no accessibility violations', async ({ page }) => {
    await openPage(page)
    await expect(page.locator('[data-resource]')).toHaveCount(2)
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(violations.map((violation) => violation.id)).toEqual([])
  })
})
