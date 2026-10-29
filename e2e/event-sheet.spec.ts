import { expect, test } from '@playwright/test'
import { openApp, press, switchView } from './helpers'

test.describe('event sheet', () => {
  test('opens on a tap, shows visible Edit and Delete buttons, and closes with Escape', async ({
    page,
  }) => {
    await openApp(page)
    await switchView(page, 'Week')
    const area = page.locator('[data-calendar-main]')
    await press(area.getByText('Sprint planning').first())

    const sheet = page.getByRole('dialog', { name: 'Sprint planning' })
    await expect(sheet).toBeVisible()
    for (const name of ['Edit', 'Delete']) {
      const button = sheet.getByRole('button', { name })
      await expect(button).toBeVisible()
      const box = await button.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }

    await press(sheet.getByRole('button', { name: 'Edit' }))
    await expect(
      page.getByText('Editing arrives with the real calendar service', { exact: true }),
    ).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    // Focus is back in the calendar, not lost to the page.
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-calendar-main]')))
      .toBe(true)
  })

  test('shows a blocked event as Busy, without details', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.locator('[data-calendar-main]').getByText('Busy').first())
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('Busy').first()).toBeVisible()
    // No details, and nothing to edit for someone who cannot see the event.
    await expect(sheet.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await expect(sheet.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  })
})
