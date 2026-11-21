import { expect, test, type Page } from '@playwright/test'
import { scan } from './axe-scan'
import { openApp, press } from './helpers'

// "Hide" in the menu of a sidebar item (FR-21): the item is switched off and moves into the
// "Hidden" section at the bottom, with the icon of its kind instead of its colour, and an open eye
// that puts it back in its section, still off. In demo mode the list stays in the page; the live
// spec covers the account. "Team" is a calendar and a view, "Personal" a calendar and a category:
// the eyes are told apart by the kind in their names.

async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

// A column on wide screens, a slideover (a dialog) on narrow ones.
const sidebar = (page: Page) =>
  page
    .getByRole('complementary', { name: 'Views and calendars' })
    .or(page.getByRole('dialog', { name: 'Views and calendars' }))

const section = (page: Page, title: string) =>
  sidebar(page)
    .locator('section')
    .filter({
      has: page.getByRole('heading', { level: 2, name: title, exact: true }),
    })

async function hide(page: Page, menu: string): Promise<void> {
  await press(sidebar(page).getByRole('button', { name: menu, exact: true }))
  await press(page.getByRole('menuitem', { name: 'Hide', exact: true }))
}

test('each kind of item is hidden into one section, told apart by its icon and its name', async ({
  page,
}) => {
  const { errors } = await openApp(page)
  await showSidebar(page)
  await expect(section(page, 'Hidden')).toHaveCount(0)
  const team = section(page, 'Calendars').getByRole('switch', { name: 'Team' })
  await expect(team).toBeChecked()

  await hide(page, 'Actions for calendar Team')
  const hidden = section(page, 'Hidden')
  const eye = hidden.getByRole('button', { name: 'Unhide calendar Team', exact: true })
  await expect(eye).toBeVisible()
  // the focus goes where the item went, so that it can be put back at once
  await expect(eye).toBeFocused()
  await expect(section(page, 'Calendars').getByRole('switch', { name: 'Team' })).toHaveCount(0)

  await hide(page, 'Actions for view Team')
  await hide(page, 'Actions for resource Van')
  await hide(page, 'Actions for category Personal')
  await hide(page, 'Actions for filter Offsite')
  // in the order of the sections, each kind with its own icon and no colour
  await expect(hidden.locator('li')).toHaveText(['Team', 'Team', 'Van', 'Personal', 'Offsite'])
  const names = await hidden
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
    )
  expect(names).toEqual([
    'Hidden',
    'Unhide view Team',
    'Unhide calendar Team',
    'Unhide resource Van',
    'Unhide category Personal',
    'Unhide filter Offsite',
  ])
  const icons = await hidden
    .locator('li > :first-child')
    .evaluateAll((items) => items.map((item) => item.className))
  expect(new Set(icons).size).toBe(5)
  for (const box of await hidden.getByRole('button').all()) {
    const size = await box.boundingBox()
    expect(size!.height).toBeGreaterThanOrEqual(44)
  }
  expect(await scan(page)).toEqual([])
  expect(errors).toEqual([])
})

test('the eye puts an item back in its section, switched off, and it can be switched on', async ({
  page,
}) => {
  await openApp(page)
  await showSidebar(page)
  await hide(page, 'Actions for calendar Team')
  await hide(page, 'Actions for filter Offsite')

  await press(sidebar(page).getByRole('button', { name: 'Unhide calendar Team', exact: true }))
  const team = section(page, 'Calendars').getByRole('switch', { name: 'Team' })
  await expect(team).not.toBeChecked()
  // the focus goes to the item's menu, back in its section
  await expect(
    sidebar(page).getByRole('button', { name: 'Actions for calendar Team', exact: true }),
  ).toBeFocused()
  await press(team)
  await expect(team).toBeChecked()

  // the last one put back takes the section with it
  await press(sidebar(page).getByRole('button', { name: 'Unhide filter Offsite', exact: true }))
  await expect(section(page, 'Hidden')).toHaveCount(0)
  await expect(
    sidebar(page).getByRole('button', { name: 'Actions for filter Offsite', exact: true }),
  ).toBeFocused()
})

test('a hidden calendar stays off when a view that holds it is chosen', async ({ page }) => {
  await openApp(page)
  await showSidebar(page)
  await hide(page, 'Actions for calendar Team')
  // "Team" (the view) holds the calendar Team
  await press(section(page, 'Views').getByRole('button', { name: 'Team', exact: true }))
  await press(sidebar(page).getByRole('button', { name: 'Unhide calendar Team', exact: true }))
  await expect(section(page, 'Calendars').getByRole('switch', { name: 'Team' })).not.toBeChecked()
})
