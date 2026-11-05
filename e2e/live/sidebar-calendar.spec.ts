import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { openSignedIn } from './session'

// "Add calendar" in the sidebar with the real stack (design S8 setup): a text field and a plus, like
// the ones for views, categories and filters. The calendar is made in alice's own home through the
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

test('the calendars section has a labelled field and a plus', async () => {
  await expect(calendarsSection().getByLabel('New calendar name')).toBeVisible()
  await expect(calendarsSection().getByRole('button', { name: 'Add calendar' })).toBeVisible()
  const { violations } = await new AxeBuilder({ page })
    .include('#app-sidebar')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(violations.map((violation) => violation.id)).toEqual([])
})

test('refuses the name of a calendar that is there already', async () => {
  const field = calendarsSection().getByLabel('New calendar name')
  // The first calendar in the list, whatever its name is.
  const existing = (await calendarsSection().locator('ul li').first().innerText()).trim()
  expect(existing).not.toBe('')
  await field.fill(existing)
  await field.press('Enter')
  await expect(calendarsSection()).toContainText('A calendar with this name already exists.')
  await field.fill('')
})

test('makes a calendar with Enter, lists it without a reload and empties the field', async () => {
  const field = calendarsSection().getByLabel('New calendar name')
  await field.fill(NAME)
  await field.press('Enter')
  await expect(calendarsSection().getByText(NAME, { exact: true })).toBeVisible()
  await expect(field).toHaveValue('')
  // The focus stays where the person typed.
  await expect(field).toBeFocused()
  expect(await findCollection(aliceSub())).not.toBeNull()
})

test('the calendar is still there after a reload', async () => {
  await page.reload()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
  await expect(calendarsSection().getByText(NAME, { exact: true })).toBeVisible()
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
