import { expect, test, type Page } from '@playwright/test'
import { TODAY, openApp } from './helpers'

// External CalDAV accounts (FR-8) in demo mode. Demo mode has no login and no API behind it, so the
// section is not offered, nothing asks the server for accounts and no password prompt can appear.
// (The section itself needs the login; its behaviour is covered by the component tests.)

/** Every request to the routes of the external accounts or of their proxy. */
function watchExternalRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (/^\/api\/external(-accounts)?(\/|$)/.test(path)) seen.push(`${request.method()} ${path}`)
  })
  return seen
}

test.describe('external accounts in demo mode', () => {
  test('the settings screen offers no section for them and asks for none', async ({ page }) => {
    const external = watchExternalRequests(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      // Chromium reports every refused request as "Failed to load resource": the settings routes of
      // the real server are not there in this run, which is not what is looked at here.
      if (message.type() === 'error' && !/^Failed to load resource/.test(message.text())) {
        errors.push(message.text())
      }
    })
    // Answer the routes the other settings sections ask for, so the page settles.
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/me') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            id: 1,
            sub: 'demo',
            username: 'alice',
            name: 'Alice',
            email: null,
            isAdmin: false,
            timeZone: null,
          }),
        })
      }
      if (path === '/api/app-tokens') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ tokens: [], limit: 10 }),
        })
      }
      if (path === '/api/ical-subscriptions') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ subscriptions: [] }),
        })
      }
      return route.fallback()
    })

    await page.clock.setFixedTime(TODAY)
    await page.goto('/settings')
    const main = page.locator('main.main-area')
    await expect(main.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(main.getByText('Loading app tokens')).toBeHidden()
    await expect(page.getByText('Nothing is saved in demo mode')).toBeVisible()

    await expect(main.getByRole('heading', { name: 'External CalDAV accounts' })).toHaveCount(0)
    await expect(main.getByRole('region', { name: 'External CalDAV accounts' })).toHaveCount(0)
    await expect(main.getByRole('button', { name: 'Add account' })).toHaveCount(0)
    expect(external).toEqual([])
    expect(errors).toEqual([])
  })

  test('the calendar loads no account and shows no password prompt', async ({ page }) => {
    const external = watchExternalRequests(page)
    const { errors } = await openApp(page)
    await expect(page.getByRole('button', { name: /Enter password again/ })).toHaveCount(0)
    await expect(page.locator('[data-sidebar-problems]')).toHaveCount(0)
    expect(external).toEqual([])
    expect(errors).toEqual([])
  })
})
