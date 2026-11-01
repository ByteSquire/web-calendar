import { expect, test, type Page } from '@playwright/test'
import { openApp, press } from './helpers'

// "Appearance" in the ⋮ menu chooses the colour scheme (components/OverflowMenu.vue): some phone
// browsers darken pages themselves and do not tell the page, so the choice is made in the app.

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'))

async function chooseAppearance(page: Page, name: 'System default' | 'Light' | 'Dark') {
  await press(page.getByRole('button', { name: 'More options' }))
  await press(page.getByRole('menuitem', { name: 'Appearance' }))
  await press(page.getByRole('menuitemcheckbox', { name, exact: true }))
}

test.describe('appearance', () => {
  test('sits under full screen, and the choice sets the scheme and is kept', async ({ page }) => {
    await openApp(page)
    const system = test.info().project.use.colorScheme === 'dark'
    expect(await isDark(page)).toBe(system)

    await chooseAppearance(page, system ? 'Light' : 'Dark')
    await expect.poll(() => isDark(page)).toBe(!system)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      system ? 'light' : 'dark',
    )

    // Kept after a reload.
    await page.reload()
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    expect(await isDark(page)).toBe(!system)

    // The system default follows the device again.
    await chooseAppearance(page, 'System default')
    await expect.poll(() => isDark(page)).toBe(system)
  })

  test('lists Appearance after Full screen and marks the current choice', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'WebKit has no full screen for pages')
    await openApp(page)
    await press(page.getByRole('button', { name: 'More options' }))
    const items = page.getByRole('menuitem')
    const names = (await items.allInnerTexts()).map((text) => text.trim())
    expect(names.indexOf('Appearance')).toBe(names.indexOf('Full screen') + 1)

    await press(page.getByRole('menuitem', { name: 'Appearance' }))
    await expect(page.getByRole('menuitemcheckbox', { name: 'System default' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
