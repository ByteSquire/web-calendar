import { expect, test, type Page } from '@playwright/test'
import { scan } from './axe-scan'
import {
  closeDialogs,
  isTouch,
  openApp,
  pointAt,
  press,
  settledDialogs,
  switchView,
} from './helpers'

// The split view with rows and columns swapped (components/SplitColumns.vue): a column per
// calendar, a row per day, an entry of several days one block down its rows. Runs on every
// project, so on the phones (portrait and landscape), the tablet, the desktop and dark mode.
// The mock week is Mon 26 Oct to Sun 1 Nov 2026; the Engineering offsite of Team runs Tue to Thu.

async function openColumns(page: Page) {
  const opened = await openApp(page)
  await switchView(page, 'Split')
  const toggle = page.getByRole('button', { name: 'Swap rows and columns' })
  await press(toggle)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.split-columns')).toBeVisible()
  return opened
}

const table = (page: Page) => page.locator('.split-columns')

test.describe('split view, calendars as columns', () => {
  test('swaps rows and columns and back', async ({ page }) => {
    const { errors } = await openColumns(page)
    await expect(table(page).getByRole('columnheader', { name: 'Team' })).toBeVisible()
    await expect(table(page).getByRole('rowheader')).toHaveCount(7)

    await press(page.getByRole('button', { name: 'Swap rows and columns' }))
    await expect(page.locator('.split-columns')).toHaveCount(0)
    await expect(page.getByRole('rowheader', { name: 'Team' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('runs an entry of several days down exactly its days', async ({ page }) => {
    await openColumns(page)
    // A piece in each of its days, one under the other with no gap: Tuesday to Thursday.
    const pieces = table(page).locator('td[data-event-id="evt-offsite"]')
    await expect(pieces).toHaveCount(3)
    await pieces.first().scrollIntoViewIfNeeded()
    const rows = table(page).getByRole('rowheader')
    const boxes = await pieces.evaluateAll((cells) =>
      cells.map((cell) => {
        const { y, height, x } = cell.getBoundingClientRect()
        return { top: y, bottom: y + height, x }
      }),
    )
    const [tuesday, thursday] = await Promise.all([
      rows.nth(1).boundingBox(),
      rows.nth(3).boundingBox(),
    ])
    if (!tuesday || !thursday) throw new Error('not laid out')
    expect(Math.abs(boxes[0]!.top - tuesday.y)).toBeLessThan(3)
    expect(Math.abs(boxes[2]!.bottom - (thursday.y + thursday.height))).toBeLessThan(3)
    for (let index = 1; index < boxes.length; index += 1) {
      expect(Math.abs(boxes[index]!.top - boxes[index - 1]!.bottom)).toBeLessThan(1)
      expect(boxes[index]!.x).toBe(boxes[0]!.x)
    }
    await expect(pieces.first()).toContainText('Engineering offsite')

    // Team is only split on those days: on Monday its day cell is as wide as the whole column.
    const teamHeader = await table(page).getByRole('columnheader', { name: 'Team' }).boundingBox()
    const teamDay = (date: string) =>
      table(page)
        .locator(`td.split-columns__day[data-calendar-id="cal-team"][data-date="${date}"]`)
        .boundingBox()
    const [monday, wednesday] = await Promise.all([teamDay('2026-10-26'), teamDay('2026-10-28')])
    if (!teamHeader || !monday || !wednesday) throw new Error('not laid out')
    expect(Math.abs(monday.width - teamHeader.width)).toBeLessThan(2)
    expect(wednesday.width).toBeLessThan(monday.width - 20)
  })

  test('opens an entry, and a tap on an empty day asks for a new event in that calendar', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium' && isTouch(), 'the touch is sent through Chromium')
    await openColumns(page)
    await press(table(page).getByRole('button', { name: /^Standup/ }))
    await expect(page.getByRole('dialog', { name: /Standup/ })).toBeVisible()
    await closeDialogs(page)

    // Saturday 31 October has nothing in Team.
    const cell = table(page).locator('td.split-columns__day[data-calendar-id="cal-team"]').nth(5)
    await cell.scrollIntoViewIfNeeded()
    const box = await cell.boundingBox()
    if (!box) throw new Error('no cell')
    await pointAt(page, box.x + box.width / 2, box.y + box.height / 2)
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Team')
    expect(await settledDialogs(page)).toHaveLength(1)
  })

  test('the page does not scroll sideways; the table does, and keeps its headers in view', async ({
    page,
  }) => {
    await openColumns(page)
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(pageOverflow).toBe(0)

    const scroller = table(page)
    await scroller.evaluate((element) => element.scrollTo(400, 400))
    const [area, corner, monday] = await Promise.all([
      scroller.boundingBox(),
      scroller.getByRole('columnheader', { name: 'Date' }).boundingBox(),
      scroller.getByRole('rowheader').first().boundingBox(),
    ])
    if (!area || !corner || !monday) throw new Error('not laid out')
    // The header row stays at the top of the table's area, the dates at its start.
    expect(Math.abs(corner.y - area.y)).toBeLessThan(2)
    expect(Math.abs(corner.x - area.x)).toBeLessThan(2)
    expect(Math.abs(monday.x - area.x)).toBeLessThan(2)
  })

  test('entries, blocks and the toggle are at least 44 px high on a touch screen', async ({
    page,
  }) => {
    test.skip(!isTouch(), 'the 44 px rule is for touch screens')
    await openColumns(page)
    const small = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '.split-columns button, .split-columns td[data-event-id], .split-view button',
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const box = element.getBoundingClientRect()
          return { name: element.textContent?.trim().slice(0, 24), h: box.height, w: box.width }
        })
        .filter((item) => item.h < 43.5 || item.w < 43.5),
    )
    expect(small).toEqual([])
  })

  test('has no accessibility problems an automated scan finds', async ({ page }) => {
    await openColumns(page)
    // Away from the toggle: a solid button is paler while the pointer is on it.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    expect(await scan(page)).toEqual([])
  })

  test('a page break between two days of a block leaves both parts of it drawn', async ({
    page,
  }) => {
    await openColumns(page)
    await page.setViewportSize({ width: 794, height: 1123 })
    await page.emulateMedia({ media: 'print' })
    // Whatever the break, every day of the block has its own piece in the block's colour.
    const pieces = table(page).locator('td[data-event-id="evt-offsite"]')
    await expect(pieces).toHaveCount(3)
    for (const piece of await pieces.all()) {
      const box = await piece.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThan(20)
      const edge = await piece.evaluate((cell) => getComputedStyle(cell).borderLeftColor)
      expect(edge).not.toBe('rgba(0, 0, 0, 0)')
    }
  })

  test('prints the table without the buttons above it', async ({ page }) => {
    await openColumns(page)
    // The width of an A4 page in portrait, whatever the screen.
    await page.setViewportSize({ width: 794, height: 1123 })
    await page.emulateMedia({ media: 'print' })
    await expect(page.getByRole('button', { name: 'Swap rows and columns' })).toBeHidden()
    await expect(page.getByRole('group', { name: 'Period' })).toBeHidden()
    await expect(table(page).getByRole('columnheader', { name: 'Team' })).toBeVisible()
    // On paper the columns share the page: nothing is cut off at the right edge.
    const overflow = await table(page).evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
