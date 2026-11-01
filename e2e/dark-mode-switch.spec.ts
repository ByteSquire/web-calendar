import { expect, test, type Page } from '@playwright/test'
import { openApp, press, TODAY } from './helpers'

// "Dark mode" in the ⋮ menu is a switch (components/OverflowMenu.vue). It shows the system's scheme
// until it is flipped; then on is dark and off is light, and the page keeps the choice.

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'))

const darkMode = (page: Page) => page.getByRole('menuitemcheckbox', { name: 'Dark mode' })

test.describe('dark mode switch', () => {
  test('follows the system, then flips the scheme and is kept after a reload', async ({ page }) => {
    await openApp(page)
    // A frozen Date.now() makes Vue skip the menu item's pointerdown handler, so the menu would
    // select the item twice per tap and the switch would flip back: let the time run.
    await page.clock.setSystemTime(TODAY)
    const system = test.info().project.use.colorScheme === 'dark'
    expect(await isDark(page)).toBe(system)

    await press(page.getByRole('button', { name: 'More options' }))
    await expect(darkMode(page)).toHaveAttribute('aria-checked', String(system))

    // Flipping it applies the other scheme at once, and the menu stays open with the switch moved.
    await press(darkMode(page))
    await expect.poll(() => isDark(page)).toBe(!system)
    await expect(darkMode(page)).toHaveAttribute('aria-checked', String(!system))
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      system ? 'light' : 'dark',
    )

    await page.reload()
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    expect(await isDark(page)).toBe(!system)

    // Off is light and on is dark, whatever the system says.
    await press(page.getByRole('button', { name: 'More options' }))
    await expect(darkMode(page)).toHaveAttribute('aria-checked', String(!system))
    await press(darkMode(page))
    await expect.poll(() => isDark(page)).toBe(system)
  })

  test('sits right under Full screen', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit has no full screen for pages')
    await openApp(page)
    await press(page.getByRole('button', { name: 'More options' }))
    const names = (await page.locator('[role^="menuitem"]').allInnerTexts()).map((text) =>
      text.trim(),
    )
    expect(names.indexOf('Dark mode')).toBe(names.indexOf('Full screen') + 1)
  })
})
