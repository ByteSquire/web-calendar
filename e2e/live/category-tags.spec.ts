import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { openSignedIn } from './session'

// A category that only events carry, with the real stack: alice has an event with CATEGORIES in
// Radicale and no category of that name. Its row in the sidebar offers Colour, which saves it as
// one of her categories; after a reload it keeps the colour and is a category like any other. With
// "Category colours on events" the event shows a dot of it. The test removes what it made.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const TAG = `E2E tag ${STAMP}`
const UID = `e2e-tag-${STAMP}`
const RADICALE = 'http://radicale:5232'
const DB_PATH = '/tmp/e2e-live.db'

let page: Page
let problems: string[] = []
let sub = ''

function today(hour: number): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(hour)}0000`
}

const eventPath = () => `/${sub}/def-calendar/${UID}.ics`

function storedCategory(): { name: string; color: string | null } | undefined {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT name, color FROM categories WHERE name = ?').get(TAG) as
      { name: string; color: string | null } | undefined
  } finally {
    db.close()
  }
}

test.beforeAll(async ({ browser }) => {
  const session = await openSignedIn(browser, 'alice')
  page = session.page
  problems = session.problems
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  sub = (
    db.prepare("SELECT oidc_sub FROM users WHERE username = 'alice'").get() as {
      oidc_sub: string
    }
  ).oidc_sub
  db.close()
  const put = await fetch(`${RADICALE}${eventPath()}`, {
    method: 'PUT',
    headers: { 'X-Remote-User': sub, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//e2e//tags//EN',
      'BEGIN:VEVENT',
      `UID:${UID}`,
      `DTSTAMP:${today(8)}Z`,
      `DTSTART;TZID=Europe/Berlin:${today(12)}`,
      `DTEND;TZID=Europe/Berlin:${today(13)}`,
      'SUMMARY:Tagged lunch',
      `CATEGORIES:${TAG}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  })
  expect(put.status).toBe(201)
  await page.reload()
})

test.afterAll(async () => {
  await fetch(`${RADICALE}${eventPath()}`, { method: 'DELETE', headers: { 'X-Remote-User': sub } })
  await page.context().close()
})

const sidebar = () => page.locator('#app-sidebar')
const tagMenu = () =>
  sidebar().getByRole('button', { name: `Actions for category ${TAG}`, exact: true })

test('the name the event carries is listed, and its only action is Colour', async () => {
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.locator('[data-calendar-main]')).toContainText('Tagged lunch')
  await expect(sidebar().getByText(TAG, { exact: true })).toBeVisible()
  await tagMenu().click()
  await expect(page.getByRole('menuitem')).toHaveText(['Colour', 'Turn into a status…'])
  expect(storedCategory()).toBeUndefined()
})

test('Colour saves it as her category, kept after a reload', async () => {
  await page.getByRole('menuitem', { name: 'Colour' }).click()
  const dialog = page.getByRole('dialog', { name: `Colour of ${TAG}` })
  await expect(dialog).toContainText('is saved as one of your categories')
  await dialog.getByText('Red', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  expect(storedCategory()).toEqual({ name: TAG, color: '#b91c1c' })

  await page.reload()
  await expect(sidebar().getByText(TAG, { exact: true })).toBeVisible()
  await tagMenu().click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Rename',
    'Colour',
    'Turn into a status…',
    'Delete',
  ])
  await page.keyboard.press('Escape')
})

test('with category colours on, the event shows a dot of it', async () => {
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Category colours on events' }).click()
  const dot = page
    .locator('[data-calendar-main] .app-evt')
    .filter({ hasText: 'Tagged lunch' })
    .locator('.app-evt-tag')
  await expect(dot).toHaveCount(1)
  expect(await dot.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(185, 28, 28)',
  )
})

test('deleting the category leaves the event its name', async () => {
  await tagMenu().click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page
    .getByRole('dialog', { name: `Delete "${TAG}"?` })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect.poll(() => storedCategory()).toBeUndefined()
  // it is a name of the event again
  await expect(sidebar().getByText(TAG, { exact: true })).toBeVisible()
  const event = await fetch(`${RADICALE}${eventPath()}`, { headers: { 'X-Remote-User': sub } })
  expect(await event.text()).toContain(`CATEGORIES:${TAG}`)
})

test('no script or console errors came up', () => {
  expect(problems).toEqual([])
})
