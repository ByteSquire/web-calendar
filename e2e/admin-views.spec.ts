import { expect, test, type Page } from '@playwright/test'
import { openApp, press } from './helpers'

// The demo app has no server: the shared-view controls work on the local mock list.

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}
test.describe('shared views', () => {
  test('marks the shared view and shares an own view with everybody from its menu', async ({
    page,
  }) => {
    await openApp(page)
    await showSidebar(page)
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeVisible()
    await expect(page.getByText('Shared', { exact: true }).first()).toBeVisible()
    // there is one input for adding a view: a shared one is made by sharing an own view
    await expect(page.getByLabel('New shared view name')).toHaveCount(0)

    await page.getByLabel('New view name', { exact: true }).first().fill('Ops')
    await press(page.getByRole('button', { name: 'Add view', exact: true }).first())
    const row = page
      .locator('li')
      .filter({ has: page.getByRole('button', { name: 'Ops', exact: true }) })
    await expect(row).not.toContainText('Shared')

    await press(page.getByRole('button', { name: 'Actions for view Ops' }).first())
    await expect(page.getByRole('menuitem')).toHaveText([
      'Rename',
      'Duplicate',
      'Share with everybody',
      'Delete',
    ])
    await page.getByRole('menuitem', { name: 'Share with everybody', exact: true }).click()
    await expect(page.getByText('Shared Ops with everybody').first()).toBeVisible()
    // the shared view took the place of the own one: still one "Ops", now with the badge
    await expect(page.getByRole('button', { name: 'Ops', exact: true })).toHaveCount(1)
    await expect(row).toContainText('Shared')
    await press(page.getByRole('button', { name: 'Actions for view Ops' }).first())
    await expect(page.getByRole('menuitem')).toHaveText([
      'Rename',
      'Update from selection',
      'Copy to my views',
      'Unshare',
      'Delete',
    ])
    await page.keyboard.press('Escape')

    // and back: unsharing makes it a view of the administrator's own again, without the badge
    await press(page.getByRole('button', { name: 'Actions for view Ops' }).first())
    await page.getByRole('menuitem', { name: 'Unshare', exact: true }).click()
    await expect(page.getByText('Unshared Ops').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ops', exact: true })).toHaveCount(1)
    await expect(row).not.toContainText('Shared')
    await press(page.getByRole('button', { name: 'Actions for view Ops' }).first())
    await expect(page.getByRole('menuitem')).toHaveText([
      'Rename',
      'Duplicate',
      'Share with everybody',
      'Delete',
    ])
  })

  test('refuses to unshare a view while an own view has the same name', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    await page.getByLabel('New view name', { exact: true }).first().fill('All staff')
    await press(page.getByRole('button', { name: 'Add view', exact: true }).first())
    await press(page.getByRole('button', { name: 'Actions for view All staff' }).first())
    await page.getByRole('menuitem', { name: 'Unshare', exact: true }).click()
    await expect(
      page.getByText('You already have a view with this name. Rename one of them first.').first(),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toHaveCount(2)
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
