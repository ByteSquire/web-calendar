import { expect, test, type Page } from '@playwright/test'
import { scan } from './axe-scan'
import { openApp, press } from './helpers'

// The menu at the end of each row of the sidebar's calendars, categories and filters (design §9).
// In demo mode everything is changed in the page only; the live specs cover the server. Team is one
// of the person's own calendars (Rename, Colour, Delete); Personal is their default calendar (Rename,
// Colour: it is kept); Engineering is somebody else's (Colour).

async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

// A column on wide screens, a slideover (a dialog) on narrow ones.
const sidebar = (page: Page) =>
  page
    .getByRole('complementary', { name: 'Views and calendars' })
    .or(page.getByRole('dialog', { name: 'Views and calendars' }))

async function choose(page: Page, menu: string, item: string): Promise<void> {
  await press(sidebar(page).getByRole('button', { name: menu, exact: true }))
  await press(page.getByRole('menuitem', { name: item, exact: true }))
}

test('a calendar of the person’s own is renamed and deleted, somebody else’s only coloured', async ({
  page,
}) => {
  const { errors } = await openApp(page)
  await showSidebar(page)

  const others = sidebar(page).getByRole('button', {
    name: 'Actions for calendar Engineering',
    exact: true,
  })
  const box = await others.boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(box!.width).toBeGreaterThanOrEqual(44)
  await press(others)
  await expect(page.getByRole('menuitem')).toHaveText(['Colour'])
  await page.keyboard.press('Escape')

  // the person's default calendar is renamed and coloured, never deleted
  await press(
    sidebar(page).getByRole('button', { name: 'Actions for calendar Personal', exact: true }),
  )
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Colour'])
  await page.keyboard.press('Escape')

  await press(sidebar(page).getByRole('button', { name: 'Actions for calendar Team', exact: true }))
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Colour', 'Delete'])
  await press(page.getByRole('menuitem', { name: 'Rename' }))
  const rename = page.getByRole('dialog', { name: 'Rename calendar Team' })
  await rename.getByRole('textbox', { name: 'Name' }).fill('Personal')
  await press(rename.getByRole('button', { name: 'Save' }))
  await expect(rename).toContainText('A calendar with this name already exists.')
  await rename.getByRole('textbox', { name: 'Name' }).fill('Team plan')
  await press(rename.getByRole('button', { name: 'Save' }))
  await expect(rename).toBeHidden()
  await expect(sidebar(page).getByText('Team plan', { exact: true })).toBeVisible()

  await choose(page, 'Actions for calendar Team plan', 'Delete')
  const confirm = page.getByRole('dialog', { name: 'Delete "Team plan"?' })
  await expect(confirm).toContainText('This cannot be undone.')
  expect(await scan(page)).toEqual([])
  await press(confirm.getByRole('button', { name: 'Delete' }))
  await expect(confirm).toBeHidden()
  await expect(sidebar(page).getByText('Team plan', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a category is renamed, recoloured and deleted from its menu', async ({ page }) => {
  const { errors } = await openApp(page)
  await showSidebar(page)

  await choose(page, 'Actions for category Work', 'Rename')
  const rename = page.getByRole('dialog', { name: 'Rename category Work' })
  await expect(rename).toContainText('Events that have the old name keep it.')
  await rename.getByRole('textbox', { name: 'Name' }).fill('Travel')
  await press(rename.getByRole('button', { name: 'Save' }))
  await expect(rename).toContainText('A category with this name already exists.')
  await rename.getByRole('textbox', { name: 'Name' }).fill('Office work')
  await press(rename.getByRole('button', { name: 'Save' }))
  await expect(rename).toBeHidden()
  await expect(sidebar(page).getByText('Office work', { exact: true })).toBeVisible()

  await choose(page, 'Actions for category Office work', 'Colour')
  const colour = page.getByRole('dialog', { name: 'Colour of Office work' })
  await press(colour.getByText('Red', { exact: true }))
  await press(colour.getByRole('button', { name: 'Save' }))
  await expect(colour).toBeHidden()
  const swatch = await sidebar(page)
    .locator('li')
    .filter({ hasText: 'Office work' })
    .locator('[style*="background"]')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(swatch).toBe('rgb(185, 28, 28)')

  await choose(page, 'Actions for category Office work', 'Delete')
  const confirm = page.getByRole('dialog', { name: 'Delete "Office work"?' })
  await expect(confirm).toContainText('events keep the category name')
  await press(confirm.getByRole('button', { name: 'Delete' }))
  await expect(sidebar(page).getByText('Office work', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a filter is edited and deleted from its menu', async ({ page }) => {
  const { errors } = await openApp(page)
  await showSidebar(page)

  await choose(page, 'Actions for filter Work only', 'Edit')
  const edit = page.getByRole('dialog', { name: 'Edit filter Work only' })
  await edit.getByRole('textbox', { name: 'Name' }).fill('Work things')
  await press(edit.getByRole('button', { name: 'Save' }))
  await expect(edit).toBeHidden()
  await expect(sidebar(page).getByText('Work things', { exact: true })).toBeVisible()

  await choose(page, 'Actions for filter Work things', 'Delete')
  const confirm = page.getByRole('dialog', { name: 'Delete "Work things"?' })
  await press(confirm.getByRole('button', { name: 'Delete' }))
  await expect(sidebar(page).getByText('Work things', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
