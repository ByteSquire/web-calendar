import { expect, test } from '@playwright/test'
import { openApp, press, switchView, viewport } from './helpers'

const wide = (page: import('@playwright/test').Page) => viewport(page).width >= 768

test.describe('navigation', () => {
  test('the date buttons move the shown period and Today returns to it', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    const title = page.locator('[aria-live="polite"]:visible').first()
    const start = await title.innerText()

    await press(page.getByRole('button', { name: 'Next week' }))
    await expect(title).not.toHaveText(start)
    await press(page.getByRole('button', { name: 'Previous week' }))
    await expect(title).toHaveText(start)
    await press(page.getByRole('button', { name: 'Next week' }))
    await press(page.getByRole('button', { name: 'Today' }))
    await expect(title).toHaveText(start)
  })

  test('every view type is reachable and marks itself as the current one', async ({ page }) => {
    await openApp(page)
    for (const name of ['Day', '5 days', 'Week', 'Month', 'Year', 'Split', 'List'] as const) {
      await switchView(page, name)
    }
  })

  test('the sidebar opens and closes, and focus returns to its toggle', async ({ page }) => {
    await openApp(page)
    if (wide(page)) {
      const sidebar = page.getByRole('complementary', { name: 'Views and calendars' })
      await expect(sidebar).toBeVisible()
      await press(page.getByRole('button', { name: 'Close sidebar' }))
      await expect(sidebar).toBeHidden()
      await press(page.getByRole('button', { name: 'Open sidebar' }))
      await expect(sidebar).toBeVisible()
    } else {
      const toggle = page.getByRole('button', { name: 'Open sidebar' })
      await press(toggle)
      const dialog = page.getByRole('dialog', { name: 'Views and calendars' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Calendars', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(toggle).toBeFocused()
    }
  })

  test('toggling a calendar hides its events', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    if (!wide(page)) await press(page.getByRole('button', { name: 'Open sidebar' }))
    const area = page.locator('[data-calendar-main]')
    await expect(area.getByText('Sprint planning').first()).toBeVisible()
    await press(page.getByRole('switch', { name: 'Team', exact: true }))
    if (!wide(page)) await page.keyboard.press('Escape')
    await expect(area.getByText('Sprint planning')).toHaveCount(0)
  })

  test('the sidebar keeps its state when the width crosses 768 px (a phone turned sideways)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await openApp(page)
    const column = page.getByRole('complementary', { name: 'Views and calendars' })
    const drawer = page.getByRole('dialog', { name: 'Views and calendars' })
    await expect(drawer).toBeHidden()

    // Closed on the narrow screen stays closed on the wide one.
    await page.setViewportSize({ width: 900, height: 420 })
    await expect(column).toBeHidden()
    await press(page.getByRole('button', { name: 'Open sidebar' }))
    await expect(column).toBeVisible()

    // Open on the wide screen is the open drawer on the narrow one.
    await page.setViewportSize({ width: 360, height: 640 })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // And closed again on the way back.
    await page.setViewportSize({ width: 900, height: 420 })
    await expect(column).toBeHidden()
  })

  test('the sidebar starts open on a desktop and closed on a phone, in either orientation', async ({
    page,
  }) => {
    const column = page.getByRole('complementary', { name: 'Views and calendars' })
    const drawer = page.getByRole('dialog', { name: 'Views and calendars' })

    await page.setViewportSize({ width: 1280, height: 800 })
    await openApp(page)
    await expect(column).toBeVisible()

    // A phone turned sideways is wide enough for the column but starts without it.
    await page.setViewportSize({ width: 915, height: 412 })
    await page.reload()
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await expect(column).toBeHidden()
    await expect(drawer).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible()
  })
})
