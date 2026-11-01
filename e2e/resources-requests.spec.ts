import { expect, test } from '@playwright/test'
import { openApp, press } from './helpers'

// The booking requests page in demo mode: local mock rows, no API calls.
test.describe('resource bookings (demo)', () => {
  test('lists requests with an overlap hint; accepting declines the overlapping one', async ({
    page,
  }) => {
    const api: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/resources')) api.push(request.url())
    })
    await openApp(page)
    await page.goto('/resources/requests')
    await expect(page.getByRole('heading', { level: 1, name: 'Resource bookings' })).toBeVisible()
    await expect(page.locator('[data-request]')).toHaveCount(2)
    await expect(page.locator('[data-overlap]').first()).toBeVisible()
    await press(page.getByRole('button', { name: /^Accept Priya Nair/ }))
    await expect(page.locator('[data-request]')).toHaveCount(0)
    await expect(page.locator('[data-bookings-notice]')).toContainText('1 overlapping request')
    expect(api).toEqual([])
  })

  test('cancels an own booking', async ({ page }) => {
    await openApp(page)
    await page.goto('/resources/requests')
    await expect(page.locator('[data-mine]')).toHaveCount(1)
    await press(page.getByRole('button', { name: /^Cancel booking of Van/ }))
    await expect(page.locator('[data-mine-none]')).toBeVisible()
  })
})
