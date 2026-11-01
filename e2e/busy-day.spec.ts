import { expect, test, type Page } from '@playwright/test'
import { closeDialogs, openApp, press, switchView } from './helpers'

// NFR-1: with 10-20 calendars and a busy day of about 10 entries the Split view stays readable.
// The demo is opened with `?demo-load=busy` (app/data/mock-busy.ts): 17 calendars, and on the
// day of the fixed clock 16 entries in 11 bands (11 of them added for this test, in 8 calendars).
// "Readable" is measured as: every entry is on screen with a size you can hit, no entry covers
// another (entries that overlap in time stack in their band), the page does not scroll sideways,
// and an entry whose title is cut off (an hour is about 60 px wide in the Day span) still opens
// a sheet with the whole title. That a title is cut off at this density is not judged here.

const ADDED = [
  'Month-end close',
  'Audit call',
  'Escalation review',
  'Design critique',
  'Contract review',
  'Warehouse check',
  'Interview: backend',
  'Interview: design',
  'Security training',
  'Board prep',
  'Customer call',
]

const period = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Period' }).getByRole('button', { name, exact: true })

async function openBusySplit(page: Page, span: 'Day' | 'Week') {
  const { errors } = await openApp(page, undefined, '/?demo-load=busy')
  await switchView(page, 'Split')
  await press(period(page, span))
  await expect(period(page, span)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.split-event').first()).toBeVisible()
  return errors
}

/** The box of every entry in the split view, with its text (time, title, calendar, ...). */
async function boxes(page: Page) {
  return page.locator('.split-event').evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { name: element.textContent ?? '', x, y, width, height }
    }),
  )
}

for (const span of ['Day', 'Week'] as const) {
  test.describe(`busy day, Split view, ${span} span (NFR-1)`, () => {
    test('gives each of the calendars with entries its own band', async ({ page }) => {
      const errors = await openBusySplit(page, span)
      // 11 bands on the busy day: 3 of the default calendars and the 8 added ones.
      expect(await page.getByRole('rowheader').count()).toBeGreaterThanOrEqual(10)
      expect(await page.getByRole('rowheader').allTextContents()).toEqual(
        expect.arrayContaining(['Finance', 'Support', 'Design', 'Legal', 'Board']),
      )
      expect(errors).toEqual([])
    })

    test('shows every entry of the day, big enough to hit, none covering another', async ({
      page,
    }) => {
      await openBusySplit(page, span)
      const found = await boxes(page)
      for (const title of ADDED) {
        expect(
          found.filter((box) => box.name.includes(`${title}, `)),
          `${title} is on screen once`,
        ).toHaveLength(1)
      }
      const onDay = found.filter((box) => ADDED.some((title) => box.name.includes(`${title}, `)))
      expect(onDay).toHaveLength(ADDED.length)

      for (const box of found) {
        expect(box.height, `${box.name} is too low`).toBeGreaterThanOrEqual(20)
        expect(box.width, `${box.name} is too narrow`).toBeGreaterThanOrEqual(24)
      }
      const overlaps: string[] = []
      found.forEach((a, index) => {
        for (const b of found.slice(index + 1)) {
          const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
          const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
          if (across > 1 && down > 1) overlaps.push(`${a.name} / ${b.name}`)
        }
      })
      expect(overlaps).toEqual([])
    })

    test('does not scroll the page sideways', async ({ page }) => {
      await openBusySplit(page, span)
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
    })

    test('opens the whole title of a cut-off entry in its sheet', async ({ page }) => {
      await openBusySplit(page, span)
      const entry = page.locator('.split-event').filter({ hasText: 'Escalation review' })
      await press(entry)
      await expect(page.getByRole('dialog', { name: /Escalation review/ })).toBeVisible()
      await closeDialogs(page)
    })
  })
}
