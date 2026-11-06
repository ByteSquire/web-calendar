import { expect, test, type Page } from '@playwright/test'
import { scan } from './axe-scan'
import { openApp, press, switchView } from './helpers'

// FR-4: each calendar's colour is the viewer's choice. "Colour" in the menu of a calendar's row opens
// a dialog with the named colours, "Custom" for any colour (the browser's picker and a colour code)
// and "Default", the calendar's own. In demo mode the choice is kept in the page only; the live
// spec covers the saved preference.

async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

/** The painted fill of the confirmed entries of one calendar in the week. */
async function fillsOf(page: Page, calendar: string): Promise<string[]> {
  const fills = await page
    .locator('[data-calendar-main] .app-evt-confirmed')
    .evaluateAll(
      (elements, name) =>
        elements
          .filter((element) => (element.textContent ?? '').trim().endsWith(`, Calendar ${name}`))
          .map((element) => getComputedStyle(element).backgroundColor),
      calendar,
    )
  return [...new Set(fills)]
}

/** "Colour" in the menu of the Team calendar's row. */
async function openColour(page: Page): Promise<void> {
  await press(page.getByRole('button', { name: 'Actions for calendar Team', exact: true }))
  await press(page.getByRole('menuitem', { name: 'Colour' }))
}

const closeSidebarIfDrawer = async (page: Page) => {
  const close = page.getByRole('button', { name: 'Close sidebar' })
  if ((await page.getByRole('button', { name: 'Open sidebar' }).count()) === 0) return
  if (await close.isVisible()) await press(close)
}

test('a calendar gets a named colour, any colour, and its own back', async ({ page }) => {
  const { errors } = await openApp(page)
  await switchView(page, 'Week')
  await expect(page.locator('[data-calendar-main] .app-evt-confirmed').first()).toBeVisible()
  expect(await fillsOf(page, 'Team')).toEqual(['rgb(4, 120, 87)'])

  await showSidebar(page)
  const button = page.getByRole('button', { name: 'Actions for calendar Team', exact: true })
  const box = await button.boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(box!.width).toBeGreaterThanOrEqual(44)
  await openColour(page)
  const dialog = page.getByRole('dialog', { name: 'Colour of Team' })
  await expect(dialog).toBeVisible()
  // the calendar shows its own colour: "Default" is chosen
  await expect(dialog.getByRole('radio', { name: 'Default' })).toBeChecked()
  expect(await scan(page)).toEqual([])

  await press(dialog.getByText('Red', { exact: true }))
  await press(dialog.getByRole('button', { name: 'Save' }))
  await expect(dialog).toBeHidden()
  await closeSidebarIfDrawer(page)
  expect(await fillsOf(page, 'Team')).toEqual(['rgb(185, 28, 28)'])

  // any colour, by its code; a light one gets dark text
  await showSidebar(page)
  await openColour(page)
  await expect(dialog.getByRole('radio', { name: 'Red' })).toBeChecked()
  await press(dialog.getByText('Custom', { exact: true }))
  await expect(dialog.getByLabel('Custom colour')).toBeVisible()
  const code = dialog.getByRole('textbox', { name: 'Colour code' })
  await code.fill('ffe0')
  await expect(dialog).toContainText('Enter a colour code like #1d4ed8.')
  await code.fill('#FFE066')
  await expect(dialog).not.toContainText('Enter a colour code like #1d4ed8.')
  expect(await scan(page)).toEqual([])
  await press(dialog.getByRole('button', { name: 'Save' }))
  await expect(dialog).toBeHidden()
  await closeSidebarIfDrawer(page)
  expect(await fillsOf(page, 'Team')).toEqual(['rgb(255, 224, 102)'])
  const text = await page
    .locator('[data-calendar-main] .app-evt-confirmed')
    .filter({ hasText: 'Calendar Team' })
    .first()
    .evaluate((element) => {
      // the colour of the element that holds the entry's own text (its time or title)
      const holder = [...element.querySelectorAll<HTMLElement>('*')].find((node) =>
        [...node.childNodes].some(
          (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
        ),
      )
      return getComputedStyle(holder ?? element).color
    })
  expect(text).toBe('rgb(0, 0, 0)')

  // back to its own
  await showSidebar(page)
  await openColour(page)
  await expect(dialog.getByRole('radio', { name: 'Custom' })).toBeChecked()
  await press(dialog.getByText('Default', { exact: true }))
  await press(dialog.getByRole('button', { name: 'Save' }))
  await expect(dialog).toBeHidden()
  await closeSidebarIfDrawer(page)
  expect(await fillsOf(page, 'Team')).toEqual(['rgb(4, 120, 87)'])
  expect(errors).toEqual([])
})
