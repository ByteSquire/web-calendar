import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { APP_ORIGIN, openSignedIn } from './session'

// Admin › Calendars with the real stack: alice (an administrator) makes a calendar of the
// organization on the page; it is a collection of the app's own principal `_organization` in
// Radicale and nobody sees it until she shares it with bob, whose home then has it. She renames it
// (Radicale's displayname follows) and deletes it: the collection and bob's share go with it.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const NAME = `E2E organization ${STAMP}`
const RENAMED = `E2E organization renamed ${STAMP}`
const RADICALE = 'http://radicale:5232'
const DB_PATH = '/tmp/e2e-live.db'
const ORG = '_organization'

let alice: Page
let bob: Page
let problems: string[] = []
let calendarId = 0

function subOf(username: 'alice' | 'bob'): string {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT oidc_sub FROM users WHERE username = ?').get(username) as
      { oidc_sub: string } | undefined
    if (!row) throw new Error(`${username} has not signed in`)
    return row.oidc_sub
  } finally {
    db.close()
  }
}

function rowOf(id: number): { collection_path: string; kind: string; owner_id: number | null } {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    return db
      .prepare('SELECT collection_path, kind, owner_id FROM calendars WHERE id = ?')
      .get(id) as { collection_path: string; kind: string; owner_id: number | null }
  } finally {
    db.close()
  }
}

/** The path of the calendar named `name` in the home of `principal`, or null. */
async function pathInHome(principal: string, name: string): Promise<string | null> {
  const response = await fetch(`${RADICALE}/${encodeURIComponent(principal)}/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': principal, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  })
  for (const block of (await response.text()).split(/<(?:\w+:)?response>/).slice(1)) {
    if (!block.includes(`>${name}<`)) continue
    const href = /<(?:\w+:)?href>([^<]+)</.exec(block)?.[1]
    return href ? decodeURIComponent(href) : null
  }
  return null
}

test.beforeAll(async ({ browser }) => {
  const first = await openSignedIn(browser, 'alice')
  alice = first.page
  problems = first.problems
  bob = (await openSignedIn(browser, 'bob')).page
})

test.afterAll(async () => {
  // What a failed run left behind.
  for (const name of [NAME, RENAMED]) {
    const path = await pathInHome(ORG, name)
    if (path)
      await fetch(`${RADICALE}${path}`, { method: 'DELETE', headers: { 'X-Remote-User': ORG } })
  }
  await alice.context().close()
  await bob.context().close()
})

test('alice makes a calendar of the organization, in its own home in Radicale', async () => {
  await alice.goto('/admin/calendars')
  await expect(alice.getByRole('heading', { level: 1, name: 'Calendars' })).toBeVisible()
  await alice.getByRole('button', { name: 'New calendar' }).click()
  const dialog = alice.getByRole('dialog', { name: 'New calendar' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(NAME)
  const created = alice.waitForResponse(
    (response) =>
      response.url() === `${APP_ORIGIN}/api/admin/access/calendars` &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Add calendar' }).click()
  const answer = await created
  expect(answer.status()).toBe(201)
  calendarId = ((await answer.json()) as { calendar: { id: number } }).calendar.id
  // it opens on who has access: nobody sees it yet
  await expect(alice.getByRole('tab', { name: 'Who has access', selected: true })).toBeVisible()
  expect(rowOf(calendarId)).toMatchObject({ kind: 'shared', owner_id: null })
  expect(rowOf(calendarId).collection_path).toMatch(/^\/_organization\/[0-9a-f-]{36}\/$/)
  expect(await pathInHome(ORG, NAME)).toBe(rowOf(calendarId).collection_path)
})

test('shared with bob, it reaches his home', async () => {
  const dialog = alice.getByRole('dialog', { name: NAME })
  await dialog.getByRole('radio', { name: 'A person' }).check({ force: true })
  await dialog.getByRole('button', { name: /^Person/ }).click()
  await alice.getByRole('option', { name: /\(bob\)/ }).click()
  await dialog.getByRole('radio', { name: /^Can view/ }).check({ force: true })
  await dialog.getByRole('button', { name: 'Add access' }).click()
  await expect(dialog.locator('[data-access-rule]')).toHaveCount(1)
  await expect
    .poll(() => pathInHome(subOf('bob'), NAME), { timeout: 30_000 })
    .toMatch(new RegExp(`^/${subOf('bob')}/shared-${calendarId}/$`))
})

test('renamed on its details tab, Radicale has the new name', async () => {
  const dialog = alice.getByRole('dialog', { name: NAME })
  await dialog.getByRole('tab', { name: 'Details' }).click()
  await dialog.getByRole('textbox', { name: 'Name' }).fill(RENAMED)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(alice.locator('[data-admin-calendar]').filter({ hasText: RENAMED })).toBeVisible()
  expect(await pathInHome(ORG, RENAMED)).toBe(rowOf(calendarId).collection_path)
})

test('deleted after asking, it is gone from Radicale and from bob', async () => {
  const dialog = alice.getByRole('dialog', { name: RENAMED })
  await dialog.getByRole('button', { name: 'Delete calendar' }).click()
  const confirm = alice.getByRole('dialog', { name: `Delete "${RENAMED}"?` })
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(alice.locator('[data-admin-calendar]').filter({ hasText: RENAMED })).toHaveCount(0)
  expect(await pathInHome(ORG, RENAMED)).toBeNull()
  await expect.poll(() => pathInHome(subOf('bob'), RENAMED), { timeout: 30_000 }).toBeNull()
})

test('no script or console errors came up', () => {
  expect(problems).toEqual([])
})
