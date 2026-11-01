import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { contrastRatio, edgeColors, textColor, tokenColor, worstTextContrast } from './contrast'
import { openApp, press, switchView, TODAY } from './helpers'

// Contrast beyond what the axe scan in a11y.spec.ts judges (NFR-3, WCAG 2.1 AA): text 4.5:1, the
// edge of a control 3:1. Colours are read from what the browser painted, in the scheme of the
// project (light, or dark).

const TEXT_TIERS = [
  '--ui-text',
  '--ui-text-highlighted',
  '--ui-text-toned',
  '--ui-text-muted',
  '--ui-text-dimmed',
]

test.describe('colour tokens', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'the stylesheet is the same in every browser')
  })

  test('every text tier reads at 4.5:1 on the page and on the sidebar', async ({ page }) => {
    await openApp(page)
    const failures: string[] = []
    for (const text of TEXT_TIERS) {
      for (const background of ['--ui-bg', '--ui-bg-muted']) {
        const ratio = contrastRatio(
          await tokenColor(page, text),
          await tokenColor(page, background),
        )
        if (ratio < 4.5) failures.push(`${text} on ${background}: ${ratio.toFixed(2)}`)
      }
    }
    expect(failures).toEqual([])
  })

  test('the edge of a control stands out 3:1 from every surface it sits on', async ({ page }) => {
    await openApp(page)
    const edge = await tokenColor(page, '--app-control-border')
    const failures: string[] = []
    for (const surface of ['--ui-bg', '--ui-bg-muted', '--ui-bg-elevated']) {
      const ratio = contrastRatio(edge, await tokenColor(page, surface))
      if (ratio < 3) failures.push(`on ${surface}: ${ratio.toFixed(2)}`)
    }
    expect(failures).toEqual([])
  })

  test('the primary colour, which is the focus ring and a switch that is on, reads 3:1', async ({
    page,
  }) => {
    await openApp(page)
    const primary = await tokenColor(page, '--ui-primary')
    for (const surface of ['--ui-bg', '--ui-bg-muted']) {
      expect(contrastRatio(primary, await tokenColor(page, surface))).toBeGreaterThanOrEqual(3)
    }
  })
})

// Fields are measured as drawn: placeholders and edges are what axe leaves out.
test.describe('controls as drawn', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== 'chromium' || test.info().project.use.hasTouch === true,
      'measured in Chromium with a mouse: the sidebar is open there',
    )
  })

  async function settle(page: Page) {
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    )
  }

  test('a switch that is off has an edge, and so has a field', async ({ page }) => {
    await openApp(page)
    await page.clock.setSystemTime(TODAY)
    const off = page.locator('#app-sidebar button[role="switch"][data-state="unchecked"]').first()
    await expect(off).toBeVisible()
    await settle(page)
    const sidebarSwitch = await edgeColors(page, off)
    expect(contrastRatio(sidebarSwitch.edge, sidebarSwitch.outside)).toBeGreaterThanOrEqual(3)

    await press(page.getByRole('button', { name: 'Quick add' }))
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await expect(dialog).toBeVisible()
    await settle(page)
    const field = dialog.locator('input[type="text"]').first()
    // The dialog focuses the title on a desktop, which draws the focus ring over the edge.
    await field.evaluate((element) => element.blur())
    const colors = await edgeColors(page, field)
    expect(contrastRatio(colors.edge, colors.outside)).toBeGreaterThanOrEqual(3)
  })

  test('the switch of the overflow menu has an edge while it is off', async ({ page }) => {
    await openApp(page)
    await page.clock.setSystemTime(TODAY)
    await press(page.getByRole('button', { name: 'More options' }))
    const picture = page.locator('[data-dark-mode-switch]')
    await expect(picture).toBeVisible()
    await settle(page)
    const colors = await edgeColors(page, picture)
    expect(contrastRatio(colors.edge, colors.outside)).toBeGreaterThanOrEqual(3)
  })

  test('the placeholder of a field reads 4.5:1', async ({ page }) => {
    await openApp(page)
    const field = page.locator('#app-sidebar input[placeholder]').first()
    await expect(field).toBeVisible()
    await settle(page)
    const colors = await edgeColors(page, field)
    const placeholder = await textColor(field, '::placeholder')
    expect(contrastRatio(placeholder, colors.inside)).toBeGreaterThanOrEqual(4.5)
  })
})

// axe reports what it cannot decide (text over a hatch or a stripe, a label another element
// overlaps) as "incomplete" and the scan in a11y.spec.ts ignores that. These are measured here.
test('what axe cannot decide is still readable', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'pixels are measured in Chromium')
  await openApp(page)
  for (const view of ['Week', 'List'] as const) {
    await switchView(page, view)
    await page.waitForTimeout(400)
    const { incomplete } = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
    const targets = new Map<string, string>()
    for (const rule of incomplete) {
      for (const node of rule.nodes) {
        const selector = node.target.join(' ')
        // A few of each kind: the same cell repeats for every hour.
        const kind = `${rule.id}:${selector.replace(/\[.*?\]/g, '').slice(0, 30)}`
        if (!targets.has(kind)) targets.set(kind, selector)
      }
    }
    expect(targets.size, `${view}: nothing to measure`).toBeGreaterThan(0)
    const unreadable: string[] = []
    for (const selector of targets.values()) {
      const ratio = await worstTextContrast(page, page.locator(selector).first())
      if (ratio !== null && ratio < 4.5) unreadable.push(`${selector}: ${ratio.toFixed(2)}`)
    }
    expect(unreadable, `${view} view`).toEqual([])
  }
})
