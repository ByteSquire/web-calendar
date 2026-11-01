import { expect, test, type Page } from '@playwright/test'
import { openApp } from './helpers'

// Keyboard use (NFR-3, WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7): the Tab order follows the page (top bar,
// sidebar, calendar) and starts again at the top, nothing traps the focus, every stop shows where
// the focus is, and an event can be reached and opened without a mouse. The axe scan cannot prove
// any of this. Runs once, on the desktop project, where the sidebar is always there.

interface Stop {
  region: 'header' | 'sidebar' | 'main' | 'other' | 'body'
  /** Accessible name, shortened. */
  name: string
  /** True when the browser draws an outline, or the element has a shadow ring, around the focus. */
  ring: boolean
  /** Position among all elements, so two stops on the same element are told apart. */
  index: number
}

/** Presses Tab `count` times and describes each stop. */
async function tab(page: Page, count: number): Promise<Stop[]> {
  const stops: Stop[] = []
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab')
    stops.push(
      await page.evaluate((): Stop => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return { region: 'body', name: '', ring: true, index: -1 }
        const style = getComputedStyle(el)
        const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0
        return {
          region: el.closest('header')
            ? 'header'
            : el.closest('aside, [role=dialog]')
              ? 'sidebar'
              : el.closest('[data-calendar-main]')
                ? 'main'
                : 'other',
          name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40),
          ring: outline || style.boxShadow !== 'none',
          index: [...document.querySelectorAll('*')].indexOf(el),
        }
      }),
    )
  }
  return stops
}

/** One run is enough, and the sidebar is always shown on the desktop project. */
function desktopOnly() {
  test.skip(test.info().project.name !== 'desktop', 'runs once, on the desktop project')
}

test.describe('keyboard', () => {
  test('Tab goes through the top bar, the sidebar and the calendar, then starts again', async ({
    page,
  }) => {
    desktopOnly()
    await openApp(page)
    const stops = await tab(page, 170)
    // Runs of the same region, in the order they come.
    const runs = stops
      .map((stop) => stop.region)
      .filter((region, i, all) => i === 0 || region !== all[i - 1])
    expect(runs.slice(0, 5)).toEqual(['header', 'sidebar', 'main', 'body', 'header'])
    // The top bar leads with the controls a keyboard user needs first.
    expect(stops.slice(0, 4).map((stop) => stop.name)).toEqual([
      'Close sidebar',
      'Previous week',
      'Today',
      'Next week',
    ])
  })

  test('no stop is visited twice before the focus leaves the page (no keyboard trap)', async ({
    page,
  }) => {
    desktopOnly()
    await openApp(page)
    const stops = await tab(page, 170)
    const cycle = stops.slice(
      0,
      stops.findIndex((stop) => stop.region === 'body'),
    )
    expect(cycle.length).toBeGreaterThan(40)
    expect(new Set(cycle.map((stop) => stop.index)).size).toBe(cycle.length)
  })

  test('every stop shows where the focus is', async ({ page }) => {
    desktopOnly()
    await openApp(page)
    const stops = await tab(page, 170)
    expect(
      stops.filter((stop) => !stop.ring).map((stop) => `${stop.region}: ${stop.name}`),
    ).toEqual([])
  })

  test('Shift+Tab goes back the way Tab came', async ({ page }) => {
    desktopOnly()
    await openApp(page)
    const forward = await tab(page, 20)
    await page.keyboard.press('Shift+Tab')
    const here = await page.evaluate(() =>
      [...document.querySelectorAll('*')].indexOf(document.activeElement!),
    )
    expect(here).toBe(forward[18]!.index)
  })

  test('an event is reached with Tab, opens with Enter and closes with Escape', async ({
    page,
  }) => {
    desktopOnly()
    await openApp(page)
    let found = false
    for (let i = 0; i < 170 && !found; i += 1) {
      await page.keyboard.press('Tab')
      found = await page.evaluate(
        () => document.activeElement?.textContent?.startsWith('Engineering offsite') ?? false,
      )
    }
    expect(found, 'the event is among the first 170 stops').toBe(true)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Engineering offsite')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
