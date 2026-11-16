import { expect, test, type Page } from '@playwright/test'
import { openAddDialog, openApp, press } from './helpers'

// The demo app has no server: the shared-view controls work on the local mock list.

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

/** Adds an own view with the calendars switched on now. */
async function addView(page: Page, name: string): Promise<void> {
  const dialog = await openAddDialog(page, 'Add view')
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await press(dialog.getByRole('button', { name: 'Add view', exact: true }))
  await expect(dialog).toBeHidden()
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

    await addView(page, 'Ops')
    const row = page
      .locator('li')
      .filter({ has: page.getByRole('button', { name: 'Ops', exact: true }) })
    await expect(row).not.toContainText('Shared')

    await press(page.getByRole('button', { name: 'Actions for view Ops' }).first())
    await expect(page.getByRole('menuitem')).toHaveText([
      'Edit',
      'Update from selection',
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
      'Edit',
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
      'Edit',
      'Update from selection',
      'Duplicate',
      'Share with everybody',
      'Delete',
    ])
  })

  test('refuses to unshare a view while an own view has the same name', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    await addView(page, 'All staff')
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
    await press(page.getByRole('menuitem', { name: 'Edit' }))
    const dialog = page.getByRole('dialog', { name: 'Edit shared view All staff' })
    await expect(dialog).toContainText('Everybody sees this view.')
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Everyone')
    await press(dialog.getByRole('button', { name: 'Save' }))
    await expect(page.getByRole('button', { name: 'Everyone', exact: true }).first()).toBeVisible()

    await press(page.getByRole('button', { name: 'Actions for view Everyone' }).first())
    await press(page.getByRole('menuitem', { name: 'Delete' }))
    await press(page.getByRole('dialog').getByRole('button', { name: 'Delete' }))
    await expect(page.getByRole('button', { name: 'Everyone', exact: true })).toHaveCount(0)
  })
})
