import { expect, test, type Locator, type Page } from '@playwright/test'
import { openApp, press, TODAY } from './helpers'

// "Dark mode" in the ⋮ menu is a switch (components/OverflowMenu.vue). It shows the system's scheme
// until it is flipped; then on is dark and off is light, and the page keeps the choice. A circle
// arrow next to it, there from the first flip, goes back to following the system.

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'))

const darkMode = (page: Page) => page.getByRole('menuitemcheckbox', { name: 'Dark mode' })
const followSystem = (page: Page) => page.getByRole('menuitem', { name: 'Follow system' })
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('nuxt-color-mode'))

/** The box of an element once it has stopped moving: the menu scales in when it opens. */
async function settledBox(locator: Locator) {
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await locator.boundingBox())
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
  return locator.boundingBox()
}

async function openWithRunningClock(page: Page): Promise<void> {
  await openApp(page)
  // A frozen Date.now() makes Vue skip the menu item's pointerdown handler, so the menu would
  // select the item twice per tap and the switch would flip back: let the time run.
  await page.clock.setSystemTime(TODAY)
}

test.describe('dark mode switch', () => {
  test('follows the system, then flips the scheme and is kept after a reload', async ({ page }) => {
    await openWithRunningClock(page)
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

  test('a circle arrow beside the switch goes back to following the system', async ({ page }) => {
    await openWithRunningClock(page)
    const system = test.info().project.use.colorScheme === 'dark'
    const more = page.getByRole('button', { name: 'More options' })

    // Not there while the system is followed.
    await press(more)
    await expect(darkMode(page)).toBeVisible()
    await expect(followSystem(page)).toHaveCount(0)
    const narrow = await settledBox(page.getByRole('menu'))

    // The first flip brings it, with the menu still open.
    await press(darkMode(page))
    await expect(followSystem(page)).toBeVisible()
    await expect.poll(() => isDark(page)).toBe(!system)

    // On the row of the switch, to its right, a full touch target, and nothing lies over it.
    const row = await settledBox(darkMode(page))
    const arrow = await settledBox(followSystem(page))
    const knob = await settledBox(page.locator('[data-dark-mode-switch]'))
    const wide = await settledBox(page.getByRole('menu'))
    if (!row || !arrow || !knob || !narrow || !wide) throw new Error('no boxes')
    expect(arrow.y + arrow.height / 2).toBeGreaterThan(row.y)
    expect(arrow.y + arrow.height / 2).toBeLessThan(row.y + row.height)
    expect(arrow.x).toBeGreaterThanOrEqual(knob.x + knob.width)
    expect(arrow.width).toBeGreaterThanOrEqual(44)
    expect(arrow.height).toBeGreaterThanOrEqual(44)
    // The menu widened to fit the arrow if the row needed it (a longer item may make it wide
    // enough already), towards the left: it keeps its right edge, and the arrow is inside it and on
    // the screen.
    expect(wide.width).toBeGreaterThanOrEqual(narrow.width)
    expect(Math.abs(wide.x + wide.width - (narrow.x + narrow.width))).toBeLessThan(1.5)
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(wide.x + wide.width + 0.5)
    expect(wide.x).toBeGreaterThanOrEqual(0)

    // Pressing it (the press fails if another item covers it) follows the system again, and the
    // menu closes.
    await press(followSystem(page))
    await expect.poll(() => isDark(page)).toBe(system)
    expect(await stored(page)).toBe('system')
    await expect(page.getByRole('menu')).toBeHidden()

    // The page follows the device again, and the arrow is gone once more.
    await page.emulateMedia({ colorScheme: system ? 'light' : 'dark' })
    await expect.poll(() => isDark(page)).toBe(!system)
    await press(more)
    await expect(darkMode(page)).toBeVisible()
    await expect(followSystem(page)).toHaveCount(0)
    // ... and the menu is as narrow as before.
    const again = await settledBox(page.getByRole('menu'))
    expect(Math.abs((again?.width ?? 0) - narrow.width)).toBeLessThan(1.5)
  })

  test('the arrow can be reached and used with the keyboard', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a keyboard test')
    await openWithRunningClock(page)
    const system = test.info().project.use.colorScheme === 'dark'
    await page.getByRole('button', { name: 'More options' }).press('Enter')
    await expect(darkMode(page)).toBeVisible()
    await darkMode(page).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => isDark(page)).toBe(!system)

    await page.keyboard.press('ArrowDown')
    await expect(followSystem(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => isDark(page)).toBe(system)
    expect(await stored(page)).toBe('system')
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
