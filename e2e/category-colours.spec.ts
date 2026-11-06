import { expect, test, type Page } from '@playwright/test'
import { scan } from './axe-scan'
import { openApp, press, switchView } from './helpers'

// "Category colours on events" in the ⋮ menu: every entry shows a dot in the colour of each of its
// categories, before the title, in the week and the split view; off again, the dots go. The choice
// is kept in the browser, so it holds after a reload.

const dots = (page: Page) =>
  page.locator('[data-calendar-main] .app-evt-tag, .split-timeline .app-evt-tag')

async function toggle(page: Page): Promise<void> {
  await press(page.getByRole('button', { name: 'More options' }))
  await press(page.getByRole('menuitemcheckbox', { name: 'Category colours on events' }))
  await expect(page.getByRole('menu')).toBeHidden()
}

test('entries show their categories as coloured dots, kept after a reload', async ({ page }) => {
  const { errors } = await openApp(page)
  await switchView(page, 'Week')
  await expect(page.locator('[data-calendar-main] .app-evt-confirmed').first()).toBeVisible()
  await expect(dots(page)).toHaveCount(0)

  await toggle(page)
  await expect(dots(page).first()).toBeVisible()
  // The mock "Work" category is blue; its dot is ringed in the entry's text colour.
  const colours = await dots(page).evaluateAll((elements) => [
    ...new Set(elements.map((element) => getComputedStyle(element).backgroundColor)),
  ])
  expect(colours).toContain('rgb(29, 78, 216)')
  // the entry's name for a screen reader says its categories
  await expect(
    page
      .locator('[data-calendar-main] .sr-only')
      .filter({ hasText: /categor(y|ies) / })
      .first(),
  ).toBeAttached()
  expect(await scan(page)).toEqual([])

  await page.reload()
  await expect(dots(page).first()).toBeVisible()
  await switchView(page, 'Split')
  await expect(page.locator('.split-timeline .app-evt-tag').first()).toBeVisible()

  await toggle(page)
  await expect(dots(page)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('timed entries of the month are filled strips in their calendar colour', async ({ page }) => {
  // 360 px high: every day of the month shows only its "+ more", so there is no entry to look at.
  test.skip(test.info().project.name === 'phone-landscape', 'the month folds every entry away')
  const { errors } = await openApp(page)
  await switchView(page, 'Month')
  // Every timed entry in sight (a small screen folds some into "+ more") is filled; none is
  // FullCalendar's dot and plain text.
  const entries = page.locator('[data-calendar-main] .app-evt-confirmed')
  await expect(entries.filter({ visible: true }).first()).toBeVisible()
  const fills = await entries.evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => getComputedStyle(element).backgroundColor),
  )
  expect(fills.length).toBeGreaterThan(0)
  expect(fills).not.toContain('rgba(0, 0, 0, 0)')
  expect(await scan(page)).toEqual([])
  expect(errors).toEqual([])
})
