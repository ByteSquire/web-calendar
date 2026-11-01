import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { openSignedIn } from './session'

// NFR-4 with the real stack (design S8 setup): when a calendar cannot be loaded the sidebar lists
// it under "Problems" with a Retry button, and Retry loads it again once the server answers. The
// failure is made by refusing every request to the CalDAV gateway (503) in the browser; nothing
// on the server changes. Demo mode never loads a calendar, so the demo specs cannot reach this.
test.describe.configure({ mode: 'serial' })

let page: Page
let problems: string[] = []

test.beforeAll(async ({ browser }) => {
  const session = await openSignedIn(browser, 'alice')
  page = session.page
  problems = session.problems
})

test.afterAll(async () => {
  await page.context().close()
})

const sidebarProblems = () => page.locator('[data-sidebar-problems]')

test('lists a calendar that cannot be loaded under Problems, with Retry', async () => {
  await expect(sidebarProblems()).toHaveCount(0)
  await page.route('**/caldav/**', (route) => route.fulfill({ status: 503, body: 'down' }))
  await page.reload()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()

  await expect(sidebarProblems()).toBeVisible()
  await expect(sidebarProblems().getByRole('heading', { name: 'Problems' })).toBeVisible()
  const retry = sidebarProblems().getByRole('button', { name: /^Retry / })
  await expect(retry.first()).toBeVisible()
  // The Retry button is big enough for a finger.
  const box = await retry.first().boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(44)

  const { violations } = await new AxeBuilder({ page })
    .include('[data-sidebar-problems]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(violations.map((violation) => violation.id)).toEqual([])
})

test('Retry loads the calendar again once the server answers, and the list goes away', async () => {
  await page.unroute('**/caldav/**')
  await sidebarProblems()
    .getByRole('button', { name: /^Retry / })
    .first()
    .click()
  await expect(sidebarProblems()).toHaveCount(0)
})

test('no script or console errors came up', () => {
  // Chromium reports each refused request as "Failed to load resource"; the 503s are on purpose.
  expect(problems.filter((message) => !/status of 503/.test(message))).toEqual([])
})
