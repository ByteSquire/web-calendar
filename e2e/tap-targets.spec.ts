import { expect, test, type Page } from '@playwright/test'
import { isTouch, openApp, press, switchView } from './helpers'

// Tap targets of 44 px (NFR-1, WCAG 2.5.5, design §9) where the other specs do not look: the
// sidebar's calendar toggles, the split view's period buttons and its events. The switch itself is
// 36 x 20 px; its row and an enlarged hit area carry the 44 px, so the test taps where a finger
// would, not at the middle of the small switch.

async function openSidebar(page: Page) {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible().catch(() => false)) await press(open)
}

test.describe('sidebar calendar toggles', () => {
  test('every row is at least 44 px high and a tap on the label toggles it', async ({ page }) => {
    test.skip(!isTouch(), 'the 44 px rule is for touch screens')
    await openApp(page)
    await openSidebar(page)
    // A category is called Personal too; the calendars come first in the sidebar.
    const calendars = page.getByRole('switch', { name: 'Personal', exact: true }).first()
    await expect(calendars).toBeVisible()

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('li')]
        .filter((li) => li.querySelector('[role=switch]') && li.getClientRects().length > 0)
        .map((li) => ({
          name: li.textContent?.trim().slice(0, 24) ?? '',
          h: li.getBoundingClientRect().height,
        })),
    )
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.filter((row) => row.h < 43.5)).toEqual([])

    const before = await calendars.getAttribute('aria-checked')
    const label = page.getByText('Personal', { exact: true }).first()
    await label.tap()
    await expect(calendars).not.toHaveAttribute('aria-checked', before ?? '')
  })

  test('a tap just above and below the small switch still toggles it (the 44 px hit area)', async ({
    page,
  }) => {
    test.skip(!isTouch(), 'the 44 px rule is for touch screens')
    await openApp(page)
    await openSidebar(page)
    const calendars = page.getByRole('switch', { name: 'Team', exact: true }).first()
    await expect(calendars).toBeVisible()
    // touchscreen.tap takes viewport coordinates: the switch has to be on screen first.
    await calendars.scrollIntoViewIfNeeded()
    const box = (await calendars.boundingBox())!
    expect(box.height).toBeLessThan(44) // the point of the test: the switch is small
    const centreX = box.x + box.width / 2

    for (const offset of [-10, +10 + box.height]) {
      const was = await calendars.getAttribute('aria-checked')
      await page.touchscreen.tap(centreX, box.y + offset)
      await expect(calendars).not.toHaveAttribute('aria-checked', was ?? '')
    }
  })
})

test.describe('split view', () => {
  test('period buttons and events are at least 44 px high on a touch screen', async ({ page }) => {
    test.skip(!isTouch(), 'the 44 px rule is for touch screens')
    await openApp(page)
    await switchView(page, 'Split')
    const sizes = await page.evaluate(() => {
      const measure = (selector: string) =>
        [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => {
            const box = el.getBoundingClientRect()
            return {
              name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24),
              w: Math.round(box.width * 10) / 10,
              h: Math.round(box.height * 10) / 10,
            }
          })
      return {
        period: measure('.split-view [role=group][aria-label=Period] button'),
        events: measure('.split-timeline .split-event'),
      }
    })
    expect(sizes.period).toHaveLength(4)
    expect(sizes.events.length).toBeGreaterThan(0)
    expect(sizes.period.filter((item) => item.h < 43.5 || item.w < 43.5)).toEqual([])
    expect(sizes.events.filter((item) => item.h < 43.5)).toEqual([])
  })
})
