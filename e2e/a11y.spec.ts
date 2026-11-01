import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { TODAY, VIEW_TYPES, isTouch, openApp, press, switchView } from './helpers'

// Problems inside FullCalendar's own markup that neither an option nor a hook reaches (design §12,
// "Known gap against WCAG 2.1 AA"). axe reports them by selector; each entry names the rule, the
// selectors it applies to and why. Anything else fails the test.
const UPSTREAM: { rule: string; target: RegExp; why: string }[] = [
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
async function scan(page: Page, allow: string[] = []) {
  // Dialogs fade in; axe would measure the colours of a half-transparent dialog. Endless animations
  // (spinners) are skipped, they never finish.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  )
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return violations
    .filter((violation) => !allow.includes(violation.id))
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

  test('the overflow menu has none, with the dark mode switch off and on', async ({ page }) => {
    await openApp(page)
    await page.clock.setSystemTime(TODAY)
    // An open menu hides the page from assistive technology with aria-hidden, as a dialog does, and
    // keeps the focus inside. axe accepts focusable controls under aria-hidden only behind a
    // dialog, so the rule is left out here and what it is after is tested: Tab cannot leave.
    const menu = page.getByRole('menu')
    async function expectFocusStaysInMenu() {
      for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        await expect(menu).toBeVisible()
        expect(
          await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null),
        ).toBe(true)
      }
    }

    await press(page.getByRole('button', { name: 'More options' }))
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dark mode' })).toBeVisible()
    expect(await scan(page, ['aria-hidden-focus'])).toEqual([])
    await expectFocusStaysInMenu()

    // The first flip changes the scheme, shows the reset arrow and keeps the menu open.
    await press(page.getByRole('menuitemcheckbox', { name: 'Dark mode' }))
    await expect(page.getByRole('menuitem', { name: 'Follow system' })).toBeVisible()
    await page.waitForTimeout(400)
    expect(await scan(page, ['aria-hidden-focus'])).toEqual([])
    await expectFocusStaysInMenu()
  })

  test('the sidebar has none where it is a drawer', async ({ page }) => {
    await openApp(page)
    const open = page.getByRole('button', { name: 'Open sidebar' })
    test.skip(!(await open.isVisible()), 'the sidebar is part of the page here, scanned above')
    await press(open)
    await expect(page.getByRole('dialog')).toBeVisible()
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
