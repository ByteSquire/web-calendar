import { expect, test, type Page } from '@playwright/test'
import { openApp, press, switchView } from './helpers'

// On a touch screen a dialog opens without focusing one of its controls: a text field would open
// the on-screen keyboard (utils/focus.ts). The dialog itself takes the focus.

test.describe('opening a dialog on a touch screen', () => {
  test.beforeEach(() => {
    test.skip(!test.info().project.use.hasTouch, 'only touch screens skip the focus')
  })

  /** What has the focus: the tag, and whether it is the dialog. */
  async function focusedElement(page: Page) {
    return page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? '',
      role: document.activeElement?.getAttribute('role') ?? '',
      insideControl: Boolean(document.activeElement?.closest('input, textarea, select, button')),
    }))
  }

  test('quick-add leaves the title alone', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Quick add' }))
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toBeFocused()
    expect(await focusedElement(page)).toEqual({ tag: 'DIV', role: 'dialog', insideControl: false })

    // A tap on the field still focuses it, and Escape still closes the dialog.
    await press(dialog.getByLabel('Title'))
    await expect(dialog.getByLabel('Title')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('the event sheet and the sidebar leave their buttons alone', async ({ page }) => {
    await openApp(page)

    await press(page.getByRole('button', { name: 'Open sidebar' }))
    const sidebar = page.getByRole('dialog', { name: 'Views and calendars' })
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sidebar).toBeHidden()

    await switchView(page, 'Week')
    await press(page.locator('[data-calendar-main]').getByText('Sprint planning').first())
    const sheet = page.getByRole('dialog', { name: 'Sprint planning' })
    await expect(sheet).toBeVisible()
    await expect(sheet).toBeFocused()
  })
})
