import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { openSignedIn } from './session'

// "Add calendar" in the sidebar with the real stack (design S8 setup): a plus in the heading of the
// section that shows a text field, like the ones for views, categories and filters. The calendar is made in alice's own home through the
// CalDAV gateway and shows up in the sidebar without a reload. Nothing in the app deletes a personal
// calendar, so the test asks Radicale directly (it trusts X-Remote-User on this test network) and
// removes the one it made; a run that fails half-way leaves "E2E sidebar calendar <number>".
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const NAME = `E2E sidebar calendar ${STAMP}`
const RADICALE = 'http://radicale:5232'
const DB_PATH = '/tmp/e2e-live.db'

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

const sidebar = () => page.getByRole('complementary', { name: 'Views and calendars' })
const calendarsSection = () => sidebar().locator('section').filter({ hasText: 'Calendars' }).first()

function aliceSub(): string {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT oidc_sub FROM users WHERE username = ?').get('alice') as
      { oidc_sub: string } | undefined
    if (!row) throw new Error('alice has not signed in')
    return row.oidc_sub
  } finally {
    db.close()
  }
}

async function findCollection(sub: string): Promise<string | null> {
  const response = await fetch(`${RADICALE}/${sub}/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': sub, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  })
  for (const block of (await response.text()).split(/<(?:\w+:)?response>/).slice(1)) {
    if (!block.includes(`>${NAME}<`)) continue
    return /<(?:\w+:)?href>([^<]+)</.exec(block)?.[1] ?? null
  }
  return null
}

const plus = () => calendarsSection().getByRole('button', { name: 'Add calendar', exact: true })
const field = () => calendarsSection().getByLabel('New calendar name')

test('the calendars section has a plus that shows a labelled field, and Escape closes it', async () => {
  await expect(plus()).toBeVisible()
  await expect(plus()).toHaveAttribute('aria-expanded', 'false')
  await expect(field()).toHaveCount(0)

  await plus().click()
  await expect(plus()).toHaveAttribute('aria-expanded', 'true')
  await expect(field()).toBeVisible()
  await expect(field()).toBeFocused()
  const { violations } = await new AxeBuilder({ page })
    .include('#app-sidebar')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(violations.map((violation) => violation.id)).toEqual([])

  await field().press('Escape')
  await expect(field()).toHaveCount(0)
  await expect(plus()).toBeFocused()
})

test('refuses the name of a calendar that is there already', async () => {
  await plus().click()
  // The first calendar in the list, whatever its name is.
  const existing = (await calendarsSection().locator('ul li').first().innerText()).trim()
  expect(existing).not.toBe('')
  await field().fill(existing)
  await field().press('Enter')
  await expect(calendarsSection()).toContainText('A calendar with this name already exists.')
  // the field stays open, with the name, for a better one
  await expect(field()).toHaveValue(existing)
  await field().fill('')
})

test('makes a calendar with Enter, lists it without a reload and closes the field', async () => {
  await field().fill(NAME)
  await field().press('Enter')
  await expect(calendarsSection().getByText(NAME, { exact: true })).toBeVisible()
  await expect(field()).toHaveCount(0)
  // The focus goes back to the plus.
  await expect(plus()).toBeFocused()
  expect(await findCollection(aliceSub())).not.toBeNull()
})

test('the calendar is still there after a reload', async () => {
  await page.reload()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
  await expect(calendarsSection().getByText(NAME, { exact: true })).toBeVisible()
})

test('its colour is any colour alice picks, saved for her, and its own again on request', async () => {
  const button = calendarsSection().getByRole('button', { name: `Colour of ${NAME}`, exact: true })
  await button.click()
  const dialog = page.getByRole('dialog', { name: `Colour of ${NAME}` })
  await expect(dialog.getByRole('radio', { name: 'Default' })).toBeChecked()
  await dialog.getByText('Custom', { exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Colour code' }).fill('#ffe066')
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/calendar-prefs') && response.request().method() === 'PUT',
  )
  await dialog.getByRole('button', { name: 'Save' }).click()
  expect((await saved).status()).toBe(200)
  await expect(dialog).toBeHidden()

  // after a reload the server's preference brings it back
  await page.reload()
  await expect(calendarsSection().getByText(NAME, { exact: true })).toBeVisible()
  await button.click()
  await expect(dialog.getByRole('radio', { name: 'Custom' })).toBeChecked()
  await expect(dialog.getByRole('textbox', { name: 'Colour code' })).toHaveValue('#ffe066')
  await dialog.getByText('Default', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await button.click()
  await expect(dialog.getByRole('radio', { name: 'Default' })).toBeChecked()
  await page.keyboard.press('Escape')
})

test('removes the calendar the test made', async () => {
  const sub = aliceSub()
  const path = await findCollection(sub)
  expect(path).not.toBeNull()
  const response = await fetch(`${RADICALE}${path}`, {
    method: 'DELETE',
    headers: { 'X-Remote-User': sub },
  })
  expect(response.status).toBeLessThan(300)
  expect(await findCollection(sub)).toBeNull()
})

test('no script or console errors came up', () => {
  expect(problems).toEqual([])
})
