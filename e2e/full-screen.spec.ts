import { expect, test, type Page } from '@playwright/test'
import { openApp, press } from './helpers'

// "Full screen" in the ⋮ menu hides the address bar on a phone (composables/useFullscreen.ts).

const isFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null)

async function chooseFromMenu(page: Page, name: string): Promise<void> {
  await press(page.getByRole('button', { name: 'More options' }))
  await press(page.getByRole('menuitem', { name, exact: true }))
}

test.describe('full screen', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit has no full screen for pages')
  })

  test('turns on from the menu and off again with the same entry', async ({ page }) => {
    await openApp(page)
    expect(await isFullscreen(page)).toBe(false)

    await chooseFromMenu(page, 'Full screen')
    await expect.poll(() => isFullscreen(page)).toBe(true)

    // The calendar is still there and the menu now offers the way out.
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await chooseFromMenu(page, 'Exit full screen')
    await expect.poll(() => isFullscreen(page)).toBe(false)
  })

  test('follows the browser leaving full screen by itself', async ({ page }) => {
    await openApp(page)
    await chooseFromMenu(page, 'Full screen')
    await expect.poll(() => isFullscreen(page)).toBe(true)

    // What the Back gesture or a swipe from the top edge does.
    await page.evaluate(() => document.exitFullscreen())
    await expect.poll(() => isFullscreen(page)).toBe(false)
    await press(page.getByRole('button', { name: 'More options' }))
    await expect(page.getByRole('menuitem', { name: 'Full screen', exact: true })).toBeVisible()
  })
})
