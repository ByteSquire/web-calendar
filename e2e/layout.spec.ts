import { expect, test } from '@playwright/test'
import { VIEW_TYPES, openApp, switchView } from './helpers'

test.describe('layout', () => {
  for (const view of VIEW_TYPES) {
    test(`${view} view: the page does not scroll sideways and logs no errors`, async ({ page }) => {
      const app = await openApp(page)
      await switchView(page, view)
      // Let FullCalendar lay out and any late error surface.
      await page.waitForTimeout(500)

      const size = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        body: document.body.scrollWidth,
      }))
      expect(size.scroll).toBeLessThanOrEqual(size.inner)
      expect(size.body).toBeLessThanOrEqual(size.inner)
      expect(app.errors).toEqual([])
    })
  }
})
