import { expect, test, type Page } from '@playwright/test'
import { openApp, switchView, type VIEW_TYPES } from './helpers'

// FR-4: within a view each calendar is visually distinguishable, by colour and by label. The
// colour is read from what the browser painted on the confirmed events (cancelled and tentative
// ones are tints of it, blocked ones grey); the label is the calendar named in each entry's
// accessible name. The colours are the ones in app/data/mock.ts, as rgb(). Month and Year draw a
// timed entry as a dot without a fill, so they are not read here (the dot is not checked).

const EXPECTED: Record<string, string> = {
  Personal: 'rgb(29, 78, 216)',
  Team: 'rgb(4, 120, 87)',
  Engineering: 'rgb(109, 40, 217)',
  'Public holidays': 'rgb(185, 28, 28)',
  'Room A': 'rgb(77, 124, 15)',
  Van: 'rgb(14, 116, 144)',
}

/** The painted fill of every confirmed entry in the view, grouped by the calendar it names. */
async function fillsByCalendar(page: Page): Promise<Map<string, Set<string>>> {
  const entries = await page
    .locator('[data-calendar-main] .app-evt-confirmed')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent ?? '',
        fill: getComputedStyle(element).backgroundColor,
      })),
    )
  const fills = new Map<string, Set<string>>()
  for (const { text, fill } of entries) {
    const name = /, Calendar (.+)$/.exec(text.trim())?.[1]
    expect(name, `an entry that names no calendar: ${text}`).toBeDefined()
    fills.set(name!, (fills.get(name!) ?? new Set()).add(fill))
  }
  return fills
}

test.describe('calendars are told apart (FR-4)', () => {
  for (const view of ['Week', '5 days'] as const satisfies readonly (typeof VIEW_TYPES)[number][]) {
    test(`${view}: one colour per calendar, a different one for each, and the name in every entry`, async ({
      page,
    }) => {
      await openApp(page)
      await switchView(page, view)
      await expect(page.locator('[data-calendar-main] .app-evt-confirmed').first()).toBeVisible()
      const fills = await fillsByCalendar(page)

      // several calendars show entries, and each one paints a single colour
      expect(fills.size).toBeGreaterThanOrEqual(4)
      for (const [name, set] of fills) {
        expect([...set], `${name} paints more than one colour`).toHaveLength(1)
        expect([...set][0], `${name} paints another colour than its own`).toBe(EXPECTED[name])
      }
      // no two calendars share a colour
      const colours = [...fills.values()].map((set) => [...set][0])
      expect(new Set(colours).size).toBe(colours.length)
    })
  }
})
