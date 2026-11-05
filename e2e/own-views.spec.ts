import { expect, test, type Page } from '@playwright/test'
import { openAddField, openApp, press } from './helpers'

// A user's own views (FR-2, FR-21) in the demo, which has no server: they change the local list.
// Every view has a menu: a user's own view offers Rename, Duplicate and Delete (no more "the
// mock-up does not change views" toasts), and a shared view offers Copy to my views. That a
// viewer who is no administrator gets that menu is checked against the real login in
// e2e/live/shared-view-menu.spec.ts; the demo always shows the sidebar of an administrator.

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

const viewButton = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).first()

async function addView(page: Page, name: string): Promise<void> {
  const field = await openAddField(page, 'Add view', 'New view name')
  await field.fill(name)
  await field.press('Enter')
  await expect(viewButton(page, name)).toBeVisible()
  // the field closes once the view is added
  await expect(field).toBeHidden()
}

// The menu item is clicked, not tapped: Playwright's tap in WebKit sends a second click to the spot
// after the first one has opened a dialog, and on a small screen a new view's menu item lies where
// the dialog's Cancel button appears, so the dialog closed at once. A mouse click does not do that.
// Not tried on a real iPhone.
async function chooseAction(page: Page, view: string, action: string): Promise<void> {
  await press(page.getByRole('button', { name: `Actions for view ${view}` }).first())
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

test.describe('own views', () => {
  test('adds a view from the selection, renames it, duplicates it and deletes it', async ({
    page,
  }) => {
    const { errors } = await openApp(page)
    await showSidebar(page)

    await addView(page, 'Mine')
    // an own view is not shared: no badge on its row
    await expect(
      page
        .locator('li')
        .filter({ has: viewButton(page, 'Mine') })
        .getByText('Shared'),
    ).toHaveCount(0)

    await chooseAction(page, 'Mine', 'Rename')
    const rename = page.getByRole('dialog', { name: 'Rename view', exact: true })
    await expect(rename).toContainText('Only you see this view.')
    await rename.getByLabel('Name').fill('Mine 2')
    await press(rename.getByRole('button', { name: 'Save' }))
    await expect(viewButton(page, 'Mine 2')).toBeVisible()
    await expect(viewButton(page, 'Mine')).toHaveCount(0)

    await chooseAction(page, 'Mine 2', 'Duplicate')
    await expect(viewButton(page, 'Mine 2 (copy)')).toBeVisible()
    await expect(page.getByText('Added Mine 2 (copy) to your views').first()).toBeVisible()
    await expect(page.getByText('The mock-up does not change views.')).toHaveCount(0)

    await chooseAction(page, 'Mine 2 (copy)', 'Delete')
    const confirm = page.getByRole('dialog', { name: 'Delete "Mine 2 (copy)"?' })
    await expect(confirm).toContainText('Only this view is deleted; the calendars stay.')
    await press(confirm.getByRole('button', { name: 'Delete' }))
    await expect(viewButton(page, 'Mine 2 (copy)')).toHaveCount(0)
    await expect(viewButton(page, 'Mine 2')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('refuses a view with a name that is taken', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    await addView(page, 'Mine')
    const field = await openAddField(page, 'Add view', 'New view name')
    await field.fill('Mine')
    await field.press('Enter')
    // the field stays open with the reason
    await expect(page.getByText('A view with this name already exists.').first()).toBeVisible()
    await expect(field).toHaveValue('Mine')
    // closed again (Escape), the list holds the one view of that name
    await field.press('Escape')
    await expect(field).toBeHidden()
    await expect(viewButton(page, 'Mine')).toHaveCount(1)
  })

  test('copies a shared view to the own views, and the copy is not shared', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    await chooseAction(page, 'All staff', 'Copy to my views')
    await expect(viewButton(page, 'All staff (copy)')).toBeVisible()
    await expect(viewButton(page, 'All staff')).toBeVisible()
    // the copy has the own-view menu, the shared view still has its badge
    await press(page.getByRole('button', { name: 'Actions for view All staff (copy)' }).first())
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Update from selection' })).toHaveCount(0)
  })
})
