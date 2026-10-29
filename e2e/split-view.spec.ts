import { expect, test } from '@playwright/test'
import { openApp, switchView } from './helpers'

test.describe('split view', () => {
  test('gives each calendar with events its own band and hides the empty ones', async ({
    page,
  }) => {
    await openApp(page)
    await switchView(page, 'Split')
    const rows = page.getByRole('rowheader')
    await expect(rows.first()).toBeVisible()
    await expect(rows).toHaveText([
      'Personal',
      'Team',
      'Engineering',
      'Public holidays',
      'Room A',
      'Van',
    ])
    // Sales, Office and Marketing are off in the default selection, so they get no band.
    await expect(page.getByRole('rowheader', { name: 'Sales' })).toHaveCount(0)
  })

  test('follows the date buttons', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Split')
    const title = page.locator('[aria-live="polite"]:visible').first()
    const before = await title.innerText()
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(title).not.toHaveText(before)
  })
})
