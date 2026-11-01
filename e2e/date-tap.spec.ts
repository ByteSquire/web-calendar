import { expect, test, type Page } from '@playwright/test'
import { isTouch, openApp, switchView } from './helpers'

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

/** A touch of `radius` px at the point, sent as Chromium sends the finger of a real phone. */
async function touch(page: Page, x: number, y: number, radius: number): Promise<void> {
  const session = await page.context().newCDPSession(page)
  const point = { x, y, radiusX: radius, radiusY: radius }
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await session.detach()
}

async function pointAt(page: Page, x: number, y: number, radius = 1): Promise<void> {
  if (isTouch()) {
    await touch(page, x, y, radius)
    return
  }
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.up()
}

/**
 * Wait for the dialogs a gesture opens: a second one would show up within this time. A modal
 * hides the others from the accessibility tree, so they are found by their markup, not by role.
 */
async function settledDialogs(page: Page): Promise<string[]> {
  await page.waitForTimeout(600)
  return page
    .locator('[role="dialog"]')
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.slice(0, 20) ?? ''),
    )
}

async function closeDialogs(page: Page): Promise<void> {
  while ((await page.locator('[role="dialog"]').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
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
