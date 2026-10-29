import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { VIEW_TYPES, isTouch, openApp, press, switchView } from './helpers'

// Problems inside FullCalendar's own markup that no option reaches. axe reports them by selector;
// each entry names the rule, the selectors it applies to and why. Anything else fails the test.
const UPSTREAM: { rule: string; target: RegExp; why: string }[] = [
  {
    rule: 'label-content-name-mismatch',
    target: /^div\[aria-label="\d{1,2} \w+ \d{4}"\]$/,
    why: 'time-grid day header links are named with the long date and ignore dayHeaderFormat, so the visible "Mon 26" is not part of the name',
  },
  {
    rule: 'label-content-name-mismatch',
    target: /^div\[aria-label="Go to \d{4}-\d{2}"\]$/,
    why: 'month titles of the year view are named "Go to 2026-09" while the page shows "Sep"',
  },
  {
    rule: 'aria-required-children',
    target: /^div\[aria-rowindex="\d+"\]$/,
    why: 'the pannable time grid declares rows whose cells hang off aria-owns',
  },
  {
    rule: 'aria-required-children',
    target: /^div\[aria-labelledby="fc:\d+:month-[\d-]+"\]$/,
    why: 'the year view lists months without list items',
  },
  {
    rule: 'aria-required-children',
    target: /^(\.fc-[\w-]+)+$/,
    why: 'the resource timeline is a role="table" whose rows hang off an aria-owns list',
  },
]

// WCAG 2.1 A and AA (NFR-3), as far as an automated scan can tell.
async function scan(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return violations
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      nodes: violation.nodes
        .map((node) => node.target.join(' '))
        .filter(
          (target) =>
            !UPSTREAM.some((known) => known.rule === violation.id && known.target.test(target)),
        ),
    }))
    .filter((violation) => violation.nodes.length > 0)
}

test.describe('accessibility scan', () => {
  for (const view of VIEW_TYPES) {
    test(`${view} view has no WCAG A/AA violations`, async ({ page }) => {
      await openApp(page)
      await switchView(page, view)
      await page.waitForTimeout(500)
      expect(await scan(page)).toEqual([])
    })
  }

  test('the quick-add dialog has none', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Quick add' }))
    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeVisible()
    expect(await scan(page)).toEqual([])
  })

  test('the event sheet has none', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.locator('[data-calendar-main]').getByText('Sprint planning').first())
    await expect(page.getByRole('dialog', { name: 'Sprint planning' })).toBeVisible()
    expect(await scan(page)).toEqual([])
  })

  test('the tap targets of the top bar are at least 44 px', async ({ page }) => {
    test.skip(!isTouch(), 'tap targets matter on touch screens')
    await openApp(page)
    const small = await page.locator('header.top-bar button:visible').evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const box = button.getBoundingClientRect()
          return {
            name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
            w: box.width,
            h: box.height,
          }
        })
        .filter((item) => item.w < 44 || item.h < 44),
    )
    expect(small).toEqual([])
  })
})
