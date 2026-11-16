import { expect, test, type Page } from '@playwright/test'
import { openAddDialog, openApp, press } from './helpers'

// A user's own views (FR-2, FR-21) in the demo, which has no server: they change the local list.
// A view is added and edited in a dialog with its name and the calendars it groups; selecting it
// shows those calendars. Every view has a menu: a user's own view offers Edit, Update from
// selection, Duplicate and Delete, and a shared view offers Copy to my views. That a viewer who
// is no administrator gets that menu is checked against the real login in
// e2e/live/shared-view-menu.spec.ts; the demo always shows the sidebar of an administrator.

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

const viewButton = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).first()

/** Adds a view with the calendars switched on now, or with `calendars` only. */
async function addView(page: Page, name: string, calendars?: string[]): Promise<void> {
  const dialog = await openAddDialog(page, 'Add view')
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  if (calendars) {
    await press(dialog.getByRole('button', { name: 'Choose none' }))
    for (const calendar of calendars) {
      await press(dialog.getByRole('checkbox', { name: calendar, exact: true }))
    }
  }
  await press(dialog.getByRole('button', { name: 'Add view', exact: true }))
  // the dialog closes once the view is added
  await expect(dialog).toBeHidden()
  await expect(viewButton(page, name)).toBeVisible()
}

/** The switch of a calendar in the sidebar. */
const calendarSwitch = (page: Page, name: string) =>
  page.getByRole('switch', { name, exact: true }).first()

// The menu item is clicked, not tapped: Playwright's tap in WebKit sends a second click to the spot
// after the first one has opened a dialog, and on a small screen a new view's menu item lies where
// the dialog's Cancel button appears, so the dialog closed at once. A mouse click does not do that.
// Not tried on a real iPhone.
async function chooseAction(page: Page, view: string, action: string): Promise<void> {
  await press(page.getByRole('button', { name: `Actions for view ${view}` }).first())
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

test.describe('own views', () => {
  test('a new view groups the calendars chosen in its dialog, and selecting it shows them', async ({
    page,
  }) => {
    const { errors } = await openApp(page)
    await showSidebar(page)
    await expect(calendarSwitch(page, 'Sales')).not.toBeChecked()

    await addView(page, 'Sales desk', ['Sales', 'Public holidays'])
    // the new view is selected: exactly its calendars are on
    await expect(viewButton(page, 'Sales desk')).toHaveAttribute('aria-pressed', 'true')
    await expect(calendarSwitch(page, 'Sales')).toBeChecked()
    await expect(calendarSwitch(page, 'Public holidays')).toBeChecked()
    await expect(calendarSwitch(page, 'Team')).not.toBeChecked()

    // selecting it again clears it and brings the calendars back as they were
    await press(viewButton(page, 'Sales desk'))
    await expect(calendarSwitch(page, 'Sales')).not.toBeChecked()
    await expect(calendarSwitch(page, 'Team')).toBeChecked()

    // its dialog shows what it groups; a change shows at once when it is selected
    await press(viewButton(page, 'Sales desk'))
    await chooseAction(page, 'Sales desk', 'Edit')
    const edit = page.getByRole('dialog', { name: 'Edit view Sales desk', exact: true })
    await expect(edit.getByRole('checkbox', { name: 'Sales', exact: true })).toBeChecked()
    await expect(edit.getByRole('checkbox', { name: 'Team', exact: true })).not.toBeChecked()
    await press(edit.getByRole('checkbox', { name: 'Team', exact: true }))
    await press(edit.getByRole('button', { name: 'Save' }))
    await expect(edit).toBeHidden()
    await expect(calendarSwitch(page, 'Team')).toBeChecked()
    expect(errors).toEqual([])
  })

  test('refuses a view without a calendar', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    const dialog = await openAddDialog(page, 'Add view')
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Empty')
    await press(dialog.getByRole('button', { name: 'Choose none' }))
    await press(dialog.getByRole('button', { name: 'Add view', exact: true }))
    await expect(dialog).toContainText('Choose at least one calendar.')
    await expect(viewButton(page, 'Empty')).toHaveCount(0)
  })

  test('updates a view from the calendars switched on now', async ({ page }) => {
    await openApp(page)
    await showSidebar(page)
    // the new view is selected: Team alone is on
    await addView(page, 'Mine', ['Team'])
    await expect(calendarSwitch(page, 'Sales')).not.toBeChecked()
    await press(calendarSwitch(page, 'Sales'))
    await expect(calendarSwitch(page, 'Sales')).toBeChecked()
    await chooseAction(page, 'Mine', 'Update from selection')
    await expect(page.getByText('Updated view Mine').first()).toBeVisible()
    await chooseAction(page, 'Mine', 'Edit')
    const edit = page.getByRole('dialog', { name: 'Edit view Mine', exact: true })
    await expect(edit.getByRole('checkbox', { name: 'Sales', exact: true })).toBeChecked()
  })

  test('adds a view, edits it, duplicates it and deletes it', async ({ page }) => {
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

    await chooseAction(page, 'Mine', 'Edit')
    const rename = page.getByRole('dialog', { name: 'Edit view Mine', exact: true })
    await expect(rename).toContainText('Only you see this view.')
    await rename.getByRole('textbox', { name: 'Name' }).fill('Mine 2')
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
    const dialog = await openAddDialog(page, 'Add view')
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await name.fill('mine')
    await press(dialog.getByRole('button', { name: 'Add view', exact: true }))
    // the dialog stays open with the reason
    await expect(dialog).toContainText('A view with this name already exists.')
    await expect(name).toHaveValue('mine')
    // closed again (Escape), the list holds the one view of that name
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
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
    await expect(page.getByRole('menuitem', { name: 'Unshare' })).toHaveCount(0)
  })
})
