import { expect, test } from '@playwright/test'
import { VIEW_TYPES, openApp, switchView } from './helpers'

// "Any screen size" (requirements FR-20, NFR-3). The projects in playwright.config.ts cover the
// common devices; this spec sweeps the widths between and beyond them: 320 px is WCAG 1.4.10
// (Reflow, a 1280 px window at 400 % zoom), 2560 px is a large monitor, and the last size is a
// desktop window that is only 400 px tall; 640 x 400 is the 200 % zoom of a
// 1280 x 800 window and 320 x 256 the size WCAG 1.4.10 names for 400 % (design §9: "not clipped at 200 % zoom"). It sets its own viewport, so it
// runs once, on the desktop project, and not on every project.
const SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 414, height: 896 },
  { width: 600, height: 960 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1280, height: 400 },
  // 200 % browser zoom of a 1280 x 800 window (the layout only knows CSS pixels), and WCAG's own
  // reference for 400 % (1.4.10): 320 x 256.
  { width: 640, height: 400 },
  { width: 320, height: 256 },
] as const

test.describe('screen sizes', () => {
  for (const { width, height } of SIZES) {
    test.describe(`${width} x ${height}`, () => {
      test.use({ viewport: { width, height } })

      for (const view of VIEW_TYPES) {
        test(`${view} view fits the screen`, async ({ page }) => {
          test.skip(test.info().project.name !== 'desktop', 'sets its own viewport, runs once')
          const app = await openApp(page)
          await switchView(page, view)
          // Let FullCalendar lay out and any late error surface.
          await page.waitForTimeout(500)

          // The page itself never scrolls sideways, and the area that holds the view (the
          // standard views and the split view alike) lies on the screen.
          const fit = await page.evaluate(() => {
            const box = document.querySelector('main')?.getBoundingClientRect()
            return {
              inner: window.innerWidth,
              scroll: document.documentElement.scrollWidth,
              body: document.body.scrollWidth,
              area: box ? { left: box.left, right: box.right, height: box.height } : null,
            }
          })
          expect(fit.scroll).toBeLessThanOrEqual(fit.inner)
          expect(fit.body).toBeLessThanOrEqual(fit.inner)
          expect(fit.area).not.toBeNull()
          expect(fit.area!.left).toBeGreaterThanOrEqual(-0.5)
          expect(fit.area!.right).toBeLessThanOrEqual(fit.inner + 0.5)
          expect(fit.area!.height).toBeGreaterThan(100)

          // Every control of the top bar can be reached: below 1024 px the date navigation and
          // the view switcher sit in a strip that scrolls sideways (design §9), so a control
          // may start off screen, but scrolling it into view must bring all of it on screen.
          const stranded: string[] = []
          const controls = page.locator('header.top-bar button:visible, header.top-bar a:visible')
          for (const control of await controls.all()) {
            await control.scrollIntoViewIfNeeded()
            const box = await control.boundingBox()
            const name = (await control.getAttribute('aria-label')) ?? (await control.innerText())
            if (!box || box.x < -0.5 || box.x + box.width > width + 0.5) stranded.push(name.trim())
          }
          expect(stranded).toEqual([])
          expect(app.errors).toEqual([])
        })
      }
    })
  }
})
