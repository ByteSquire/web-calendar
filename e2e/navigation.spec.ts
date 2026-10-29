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
})
