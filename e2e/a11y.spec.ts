import { expect, test } from '@playwright/test'
import { scan } from './axe-scan'
import { TODAY, VIEW_TYPES, isTouch, openApp, press, switchView } from './helpers'

test.describe('accessibility scan', () => {
  for (const view of VIEW_TYPES) {
    test(`${view} view has no WCAG A/AA violations`, async ({ page }) => {
      await openApp(page)
      await switchView(page, view)
      await page.waitForTimeout(500)
      expect(await scan(page)).toEqual([])
    })
  }

  test('the quick-add dialog has none', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Quick add' }))
    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeVisible()
    expect(await scan(page)).toEqual([])
  })

  test('the event sheet has none', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.locator('[data-calendar-main]').getByText('Sprint planning').first())
    await expect(page.getByRole('dialog', { name: 'Sprint planning' })).toBeVisible()
    expect(await scan(page)).toEqual([])
  })

  test('the overflow menu has none, with the dark mode switch off and on', async ({ page }) => {
    await openApp(page)
    await page.clock.setSystemTime(TODAY)
    // An open menu hides the page from assistive technology with aria-hidden, as a dialog does, and
    // keeps the focus inside. axe accepts focusable controls under aria-hidden only behind a
    // dialog, so the rule is left out here and what it is after is tested: Tab cannot leave.
    const menu = page.getByRole('menu')
    async function expectFocusStaysInMenu() {
      for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        await expect(menu).toBeVisible()
        expect(
          await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null),
        ).toBe(true)
      }
    }

    await press(page.getByRole('button', { name: 'More options' }))
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dark mode' })).toBeVisible()
    expect(await scan(page, ['aria-hidden-focus'])).toEqual([])
    await expectFocusStaysInMenu()

    // The first flip changes the scheme, shows the reset arrow and keeps the menu open.
    await press(page.getByRole('menuitemcheckbox', { name: 'Dark mode' }))
    await expect(page.getByRole('menuitem', { name: 'Follow system' })).toBeVisible()
    await page.waitForTimeout(400)
    expect(await scan(page, ['aria-hidden-focus'])).toEqual([])
    await expectFocusStaysInMenu()
  })

  test('the sidebar has none where it is a drawer', async ({ page }) => {
    await openApp(page)
    const open = page.getByRole('button', { name: 'Open sidebar' })
    test.skip(!(await open.isVisible()), 'the sidebar is part of the page here, scanned above')
    await press(open)
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await scan(page)).toEqual([])
  })

  test('the tap targets of the top bar are at least 44 px', async ({ page }) => {
    test.skip(!isTouch(), 'tap targets matter on touch screens')
    await openApp(page)
    const small = await page.locator('header.top-bar button:visible').evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const box = button.getBoundingClientRect()
          return {
            name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
            w: box.width,
            h: box.height,
          }
        })
        .filter((item) => item.w < 44 || item.h < 44),
    )
    expect(small).toEqual([])
  })
})
