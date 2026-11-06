import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { APP_ORIGIN, openSignedIn } from './session'

// "Add calendar" in the sidebar with the real stack (design S8 setup): a plus in the heading of the
// section that shows a text field, like the ones for views, categories and filters. The calendar is
// made in alice's own home through the CalDAV gateway and shows up in the sidebar without a reload.
// The menu of its row then picks its colour for alice, renames it and deletes it; the test checks
// each in Radicale (it trusts X-Remote-User on this test network), and removes what a run that fails
// half-way leaves behind.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const NAME = `E2E sidebar calendar ${STAMP}`
const RENAMED = `E2E renamed calendar ${STAMP}`
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
  // Whatever a failed run left behind.
  const sub = aliceSub()
  for (const name of [NAME, RENAMED]) {
    const path = await findCollection(sub, name)
    if (path)
      await fetch(`${RADICALE}${path}`, { method: 'DELETE', headers: { 'X-Remote-User': sub } })
  }
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

async function findCollection(sub: string, name = NAME): Promise<string | null> {
  const response = await fetch(`${RADICALE}/${sub}/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': sub, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  })
  for (const block of (await response.text()).split(/<(?:\w+:)?response>/).slice(1)) {
    if (!block.includes(`>${name}<`)) continue
    return /<(?:\w+:)?href>([^<]+)</.exec(block)?.[1] ?? null
  }
  return null
}

const plus = () => calendarsSection().getByRole('button', { name: 'Add calendar', exact: true })

/** An item of the menu of a calendar's row. */
async function fromMenu(name: string, item: string): Promise<void> {
  await calendarsSection()
    .getByRole('button', { name: `Actions for calendar ${name}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}
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
  await fromMenu(NAME, 'Colour')
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
  await fromMenu(NAME, 'Colour')
  await expect(dialog.getByRole('radio', { name: 'Custom' })).toBeChecked()
  await expect(dialog.getByRole('textbox', { name: 'Colour code' })).toHaveValue('#ffe066')
  await dialog.getByText('Default', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await expect(calendarsSection().getByText(NAME, { exact: true })).toBeVisible()
  await fromMenu(NAME, 'Colour')
  await expect(dialog.getByRole('radio', { name: 'Default' })).toBeChecked()
  await page.keyboard.press('Escape')
})

test('renames it from its menu, in Radicale too', async () => {
  await fromMenu(NAME, 'Rename')
  const dialog = page.getByRole('dialog', { name: `Rename calendar ${NAME}` })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(RENAMED)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(calendarsSection().getByText(RENAMED, { exact: true })).toBeVisible()
  await expect.poll(() => findCollection(aliceSub(), RENAMED)).not.toBeNull()
})

test('deletes it from its menu after asking, in Radicale too', async () => {
  await fromMenu(RENAMED, 'Delete')
  const dialog = page.getByRole('dialog', { name: `Delete "${RENAMED}"?` })
  await expect(dialog).toContainText('This cannot be undone.')
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog).toBeHidden()
  await expect(calendarsSection().getByText(RENAMED, { exact: true })).toHaveCount(0)
  expect(await findCollection(aliceSub(), RENAMED)).toBeNull()
  // and it stays gone after a reload
  await page.reload()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
  await expect(calendarsSection().getByText(RENAMED, { exact: true })).toHaveCount(0)
})

test('her default calendar is renamed but not deleted, and the server refuses it too', async () => {
  const sub = aliceSub()
  // The app named it after her (login.spec.ts checks that).
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  const me = db.prepare("SELECT name, username FROM users WHERE username = 'alice'").get() as {
    name: string | null
    username: string
  }
  db.close()
  const name = me.name || me.username
  await calendarsSection()
    .getByRole('button', { name: `Actions for calendar ${name}`, exact: true })
    .click()
  // alice is an admin: "Edit calendar" opens it on Admin › Calendars
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Colour', 'Edit calendar'])
  await page.getByRole('menuitem', { name: 'Edit calendar' }).click()
  // the dialog of Admin › Calendars opens over the calendar, which stays where it is
  const editor = page.getByRole('dialog', { name })
  await expect(editor).toBeVisible()
  await expect(editor.locator('[data-default-calendar]')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  await editor.getByRole('tab', { name: 'Who has access' }).click()
  await expect(editor.getByRole('heading', { name: 'People and groups' })).toBeVisible()
  await editor.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(editor).toBeHidden()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()

  // The route refuses it as well, with the app's own token.
  const request = page.waitForRequest(
    (candidate) => candidate.url().includes('/api/') && !!candidate.headers()['authorization'],
  )
  await page.reload()
  const bearer = (await request).headers()['authorization']!
  const refused = await page.request.fetch(
    `${APP_ORIGIN}/api/me/calendars?href=${encodeURIComponent(`/caldav/${sub}/def-calendar/`)}`,
    { method: 'DELETE', headers: { authorization: bearer } },
  )
  expect(refused.status()).toBe(409)
  expect(await refused.json()).toMatchObject({ data: { code: 'default_calendar' } })
  const kept = await fetch(`${RADICALE}/${sub}/def-calendar/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': sub, Depth: '0' },
  })
  expect(kept.status).toBe(207)
})

test('no script or console errors came up', () => {
  expect(problems).toEqual([])
})
