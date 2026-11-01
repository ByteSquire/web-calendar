import { expect, test, type Page } from '@playwright/test'
import { VIEW_TYPES, openApp, switchView } from './helpers'

// Reduced motion (NFR-3, WCAG 2.3.3, design §9): for people who ask for less motion nothing in the
// calendar area moves. "Moves" is an animation, or a transition longer than 1 ms (the split view
// sets 0.01 ms rather than 0). Runs once, on the desktop project: the rule is a media query, not a
// device matter.

/** The elements in the page's main area that animate or transition, as `tag.class` (first five). */
async function moving(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('main')
    if (!root) return ['no main area']
    return [root, ...root.querySelectorAll('*')]
      .filter((element) => {
        const style = getComputedStyle(element)
        const animated = style.animationName !== 'none' && style.animationName !== ''
        const slow = style.transitionDuration
          .split(',')
          .some((part) => Number.parseFloat(part) > 0.001)
        return animated || slow
      })
      .map(
        (element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`,
      )
      .slice(0, 5)
  })
}

test.describe('prefers-reduced-motion', () => {
  test('nothing in the main area moves, in any view', async ({ browser }) => {
    test.skip(test.info().project.name !== 'desktop', 'a media query, runs once')
    const context = await browser.newContext({ reducedMotion: 'reduce' })
    const page = await context.newPage()
    const app = await openApp(page)
    for (const view of VIEW_TYPES) {
      await switchView(page, view)
      await page.waitForTimeout(300)
      expect(await moving(page), `${view} view`).toEqual([])
    }
    await context.close()
    expect(app.errors).toEqual([])
  })

  test('the split view does move without the preference, so the check above can fail', async ({
    browser,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'a media query, runs once')
    const context = await browser.newContext({ reducedMotion: 'no-preference' })
    const page = await context.newPage()
    await openApp(page)
    await switchView(page, 'Split')
    await page.waitForTimeout(300)
    const motion = await moving(page)
    await context.close()
    expect(motion.length).toBeGreaterThan(0)
  })
})
