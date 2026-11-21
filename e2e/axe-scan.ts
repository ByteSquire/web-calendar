import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

// Problems inside FullCalendar's own markup that neither an option nor a hook reaches (design §12,
// "Known gap against WCAG 2.1 AA"). axe reports them by selector; each entry names the rule, the
// selectors it applies to and why. Anything else fails the test.
export const UPSTREAM: { rule: string; target: RegExp; why: string }[] = [
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

/**
 * Waits until what is moving on the page has come to rest. Dialogs, popovers and toasts fade in:
 * axe would measure the colours of a half-transparent one (the muted text of a dialog fails
 * 4.5:1 at a quarter of its opacity). Endless animations (spinners) are skipped, they never
 * finish. Call it before every axe scan.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  )
}

// WCAG 2.1 A and AA (NFR-3), as far as an automated scan can tell.
export async function scan(page: Page, allow: string[] = []) {
  await settleAnimations(page)
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
