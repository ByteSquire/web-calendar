import { expect, test, type Page } from '@playwright/test'
import { openApp, press } from './helpers'

// The sections of the sidebar fold away, and the browser remembers which (FR-21).

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

test.describe('folding sidebar sections', () => {
  test('folds Views and Calendars away, and keeps them folded after a reload', async ({ page }) => {
    const { errors } = await openApp(page)
    await showSidebar(page)
    const views = page.getByRole('button', { name: 'Views', exact: true })
    const calendars = page.getByRole('button', { name: 'Calendars', exact: true })
    await expect(views).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeVisible()

    await press(views)
    await expect(views).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeHidden()
    // the other sections are not touched
    await expect(calendars).toHaveAttribute('aria-expanded', 'true')

    await page.reload()
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await showSidebar(page)
    await expect(page.getByRole('button', { name: 'Views', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeHidden()

    await press(page.getByRole('button', { name: 'Views', exact: true }))
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('every section has a heading button that the keyboard reaches', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    for (const title of ['Views', 'Calendars', 'Resources', 'Categories', 'Filters']) {
      const button = page.getByRole('button', { name: title, exact: true })
      await expect(button, title).toHaveAttribute('aria-expanded', /true|false/)
      await button.focus()
      await expect(button, title).toBeFocused()
    }
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })
})
