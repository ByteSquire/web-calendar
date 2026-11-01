import { expect, test, type Page } from '@playwright/test'
import { closeDialogs, openApp, pointAt, settledDialogs, switchView } from './helpers'

// A tap on an empty part of a day opens quick-add, a tap on an event opens its sheet, and a tap
// close to an event opens exactly one of them. The browser may send the click of a tap to an
// event card near the finger while the touch started in the cell next to it.

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function boxOf(page: Page, textStart: string): Promise<Box> {
  const entry = page
    .locator('[data-calendar-main] .app-evt')
    .filter({ hasText: new RegExp(`^${textStart}`) })
    .first()
  await entry.scrollIntoViewIfNeeded()
  const box = await entry.boundingBox()
  if (!box) throw new Error(`no box for ${textStart}`)
  return box
}

test.describe('tapping a day', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'the touch is sent through the Chromium protocol')
  })

  test('an empty part of a day opens quick-add and nothing else', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Day')
    const vendor = await boxOf(page, '11:00')

    await pointAt(page, vendor.x + vendor.width / 2, vendor.y + vendor.height + 14)

    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeVisible()
    expect(await settledDialogs(page)).toHaveLength(1)
  })

  test('an event opens its sheet and nothing else', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Day')
    const vendor = await boxOf(page, '11:00')

    await pointAt(page, vendor.x + vendor.width / 2, vendor.y + vendor.height / 2)

    await expect(page.getByRole('dialog', { name: /^11:00|Vendor/ })).toBeVisible()
    expect(await settledDialogs(page)).toHaveLength(1)
    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeHidden()
  })

  for (const radius of [1, 20]) {
    test(`close to an event, a ${radius * 2} px touch opens one dialog, never two`, async ({
      page,
    }) => {
      await openApp(page)
      await switchView(page, 'Day')
      const vendor = await boxOf(page, '11:00')
      const middle = vendor.x + vendor.width / 2
      // Above and below the card is still the day; beside it may be the time axis or the edge.
      const inDay = [
        [middle, vendor.y + vendor.height + 3],
        [middle, vendor.y + vendor.height + 10],
        [middle, vendor.y - 3],
      ]
      const beside = [
        [vendor.x + vendor.width + 3, vendor.y + vendor.height / 2],
        [vendor.x - 3, vendor.y + vendor.height / 2],
      ]

      for (const [x, y] of [...inDay, ...beside]) {
        await pointAt(page, x, y, radius)
        const opened = await settledDialogs(page)
        const where = `touch at ${Math.round(x!)},${Math.round(y!)}`
        if (inDay.some((spot) => spot[0] === x && spot[1] === y)) {
          expect(opened, where).toHaveLength(1)
        } else {
          expect(opened.length, where).toBeLessThanOrEqual(1)
        }
        await closeDialogs(page)
      }
    })
  }
})
