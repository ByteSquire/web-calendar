import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
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
    const deactivate = /^\/api\/admin\/resources\/(\d+)\/deactivate$/.exec(path)
    const found = this.resources.find((item) => item.id === Number(deactivate?.[1]))
    if (found && method === 'POST') {
      found.active = false
      return route.fulfill({ json: found })
    }
    return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
  }
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
