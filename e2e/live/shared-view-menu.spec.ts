import { expect, test, type Page } from '@playwright/test'
import { openSignedIn } from './session'

// FR-21 and FR-2 with the real stack (design S8 setup): alice (an administrator) makes a shared
// view; bob (not an administrator) sees it with the "Shared" badge and a menu with the one thing he
// may do, "Copy to my views"; the copy is his own, with the full own-view menu, and renaming and
// deleting it go through the real /api/views routes. The demo cannot show a non-administrator (it
// always shows the sidebar of one). The test removes what it made; a run that fails half-way leaves
// a shared view "E2E shared <number>" (alice can delete it) and bob's copy of it behind.
test.describe.configure({ mode: 'serial' })

const SHARED = `E2E shared ${Date.now()}`
const COPY = `${SHARED} (copy)`
const RENAMED = `${SHARED} mine`

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

const viewButton = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).first()
const actions = (page: Page, name: string) =>
  page.getByRole('button', { name: `Actions for view ${name}`, exact: true })

async function reload(page: Page): Promise<void> {
  await page.reload()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
}

test('alice makes a shared view', async () => {
  await alice.getByLabel('New shared view name', { exact: true }).fill(SHARED)
  await alice.getByRole('button', { name: 'Add shared view', exact: true }).click()
  await expect(viewButton(alice, SHARED)).toBeVisible()
  await expect(alice.locator('li').filter({ has: viewButton(alice, SHARED) })).toContainText(
    'Shared',
  )
})

test('bob sees it with the badge, no way to add a shared view, and a menu with one item', async () => {
  await reload(bob)
  await expect(viewButton(bob, SHARED)).toBeVisible()
  await expect(bob.locator('li').filter({ has: viewButton(bob, SHARED) })).toContainText('Shared')
  await expect(bob.getByLabel('New shared view name', { exact: true })).toHaveCount(0)
  // he may add a view of his own
  await expect(bob.getByLabel('New view name', { exact: true })).toBeVisible()

  await actions(bob, SHARED).click()
  await expect(bob.getByRole('menuitem')).toHaveText(['Copy to my views'])
  await bob.keyboard.press('Escape')
  await expect(bob.getByRole('menuitem')).toHaveCount(0)
})

test('bob copies it to his own views, and the copy is still there after a reload', async () => {
  await actions(bob, SHARED).click()
  await bob.getByRole('menuitem', { name: 'Copy to my views' }).click()
  await expect(viewButton(bob, COPY)).toBeVisible()
  await expect(bob.getByText(`Added ${COPY} to your views`).first()).toBeVisible()

  await reload(bob)
  await expect(viewButton(bob, COPY)).toBeVisible()
  // the copy is his own: no badge, and the own-view menu
  await expect(bob.locator('li').filter({ has: viewButton(bob, COPY) })).not.toContainText('Shared')
  await actions(bob, COPY).click()
  await expect(bob.getByRole('menuitem')).toHaveText(['Rename', 'Duplicate', 'Delete'])
  await bob.keyboard.press('Escape')
})

test("alice does not see the copy: a view of bob's own is his alone", async () => {
  await reload(alice)
  await expect(viewButton(alice, SHARED)).toBeVisible()
  await expect(viewButton(alice, COPY)).toHaveCount(0)
})

test('bob renames his copy and the new name is kept', async () => {
  await actions(bob, COPY).click()
  await bob.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const dialog = bob.getByRole('dialog', { name: 'Rename view', exact: true })
  await dialog.getByLabel('Name').fill(RENAMED)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(viewButton(bob, RENAMED)).toBeVisible()
  await expect(viewButton(bob, COPY)).toHaveCount(0)

  await reload(bob)
  await expect(viewButton(bob, RENAMED)).toBeVisible()
  await expect(viewButton(bob, COPY)).toHaveCount(0)
})

test('bob deletes his copy; the shared view stays', async () => {
  await actions(bob, RENAMED).click()
  await bob.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await bob
    .getByRole('dialog', { name: `Delete "${RENAMED}"?` })
    .getByRole('button', {
      name: 'Delete',
    })
    .click()
  await expect(viewButton(bob, RENAMED)).toHaveCount(0)

  await reload(bob)
  await expect(viewButton(bob, RENAMED)).toHaveCount(0)
  await expect(viewButton(bob, SHARED)).toBeVisible()
})

test('alice deletes the shared view and it is gone for bob', async () => {
  await actions(alice, SHARED).click()
  await alice.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await alice
    .getByRole('dialog', { name: `Delete "${SHARED}"?` })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect(viewButton(alice, SHARED)).toHaveCount(0)

  await reload(bob)
  await expect(viewButton(bob, SHARED)).toHaveCount(0)
})

test('no script or console errors came up', () => {
  expect(aliceProblems).toEqual([])
  expect(bobProblems).toEqual([])
})
