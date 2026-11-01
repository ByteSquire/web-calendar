import { expect, test } from '@playwright/test'
import { expectOpenFocus, openApp, press, switchView } from './helpers'

test.describe('quick add', () => {
  test('adds an event that shows in the current view, and returns focus', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    const opener = page.getByRole('button', { name: 'Quick add' })
    await press(opener)

    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await expect(dialog).toBeVisible()
    await expectOpenFocus(dialog, dialog.getByLabel('Title'))
    await dialog.getByLabel('Title').fill('E2E planning')
    await press(dialog.getByRole('button', { name: 'Add event' }))

    await expect(dialog).toBeHidden()
    await expect(
      page.locator('[data-calendar-main]').getByText('E2E planning').first(),
    ).toBeVisible()
    await expect(opener).toBeFocused()
  })

  test('refuses an empty title and keeps the dialog open', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Quick add' }))
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog.getByText('Enter a title.')).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('Escape closes it and focus returns to the button', async ({ page }) => {
    await openApp(page)
    const opener = page.getByRole('button', { name: 'Quick add' })
    await press(opener)
    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeHidden()
    await expect(opener).toBeFocused()
  })
})
