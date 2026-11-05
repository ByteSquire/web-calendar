import { expect, test, type Page } from '@playwright/test'
import { openSignedIn } from './session'

// FR-21 with the real stack (design S8 setup): the order of the sidebar's sections is saved for the
// account. Alice moves a section; the order is still there after a reload and in another browser
// (a new context signed in as alice), and bob, who never arranged anything, has the default order.
// The test puts the order back at the end; a run that fails half-way leaves alice with a different
// order, which the "Arrange sections" list changes back.
test.describe.configure({ mode: 'serial' })

const DEFAULT = ['Views', 'Calendars', 'Resources', 'Categories', 'Filters']
const ARRANGED = ['Views', 'Calendars', 'Filters', 'Resources', 'Categories']

let alice: Page
let bob: Page
let aliceProblems: string[] = []
let bobProblems: string[] = []

test.beforeAll(async ({ browser }) => {
  const first = await openSignedIn(browser, 'alice')
  alice = first.page
  aliceProblems = first.problems
  const second = await openSignedIn(browser, 'bob')
  bob = second.page
  bobProblems = second.problems
})

test.afterAll(async () => {
  await alice.context().close()
  await bob.context().close()
})

const headings = (page: Page) =>
  page
    .locator('#app-sidebar section[data-section-id] h2')
    .evaluateAll((items) => items.map((item) => item.textContent?.trim()))

/** Moves a section with the arrow buttons and waits until the server has the new order. */
async function move(page: Page, name: string, direction: 'up' | 'down'): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/me/sidebar-order') && response.request().method() === 'PUT',
  )
  await page.getByRole('button', { name: `Move ${name} ${direction}`, exact: true }).click()
  expect((await saved).status()).toBe(200)
}

test('starts with the default order', async () => {
  expect(await headings(alice)).toEqual(DEFAULT)
  expect(await headings(bob)).toEqual(DEFAULT)
})

test('alice moves Filters up two places and it is saved', async () => {
  await alice.getByRole('button', { name: 'Arrange sections' }).click()
  await move(alice, 'Filters', 'up')
  await move(alice, 'Filters', 'up')
  await alice.getByRole('button', { name: 'Done' }).click()
  expect(await headings(alice)).toEqual(ARRANGED)
})

test('the order is still there after a reload', async () => {
  await alice.reload()
  await expect(alice.locator('[data-calendar-main]')).toBeVisible()
  await expect.poll(() => headings(alice)).toEqual(ARRANGED)
})

test('alice has it in another browser, signed in again', async ({ browser }) => {
  const other = await openSignedIn(browser, 'alice')
  try {
    await expect.poll(() => headings(other.page)).toEqual(ARRANGED)
    expect(other.problems).toEqual([])
  } finally {
    await other.page.context().close()
  }
})

test('bob keeps the default order', async () => {
  await bob.reload()
  await expect(bob.locator('[data-calendar-main]')).toBeVisible()
  await expect.poll(() => headings(bob)).toEqual(DEFAULT)
})

test('alice puts the order back', async () => {
  await alice.getByRole('button', { name: 'Arrange sections' }).click()
  await move(alice, 'Filters', 'down')
  await move(alice, 'Filters', 'down')
  await alice.getByRole('button', { name: 'Done' }).click()
  await alice.reload()
  await expect(alice.locator('[data-calendar-main]')).toBeVisible()
  await expect.poll(() => headings(alice)).toEqual(DEFAULT)
})

test('no script or console errors came up', () => {
  expect(aliceProblems).toEqual([])
  expect(bobProblems).toEqual([])
})
