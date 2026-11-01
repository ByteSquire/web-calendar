import { expect, test, type Page } from '@playwright/test'
import { openApp, press } from './helpers'

// The demo app has no server: the shared-view controls work on the local mock list.

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}
test.describe('shared views', () => {
  test('marks the shared view and creates a shared view from the selection', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeVisible()
    await expect(page.getByText('Shared', { exact: true }).first()).toBeVisible()

    await page.getByLabel('New shared view name').first().fill('Ops')
    await press(page.getByRole('button', { name: 'Add shared view' }).first())
    await expect(page.getByRole('button', { name: 'Ops', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Actions for view Ops' }).first()).toBeVisible()
  })

  test('renames and deletes a shared view', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    await press(page.getByRole('button', { name: 'Actions for view All staff' }).first())
    await press(page.getByRole('menuitem', { name: 'Rename' }))
    const dialog = page.getByRole('dialog', { name: 'Rename shared view' })
    await dialog.getByLabel('Name').fill('Everyone')
    await press(dialog.getByRole('button', { name: 'Save' }))
    await expect(page.getByRole('button', { name: 'Everyone', exact: true }).first()).toBeVisible()

    await press(page.getByRole('button', { name: 'Actions for view Everyone' }).first())
    await press(page.getByRole('menuitem', { name: 'Delete' }))
    await press(page.getByRole('dialog').getByRole('button', { name: 'Delete' }))
    await expect(page.getByRole('button', { name: 'Everyone', exact: true })).toHaveCount(0)
  })
})
