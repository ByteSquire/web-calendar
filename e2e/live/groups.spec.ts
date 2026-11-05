import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { openSignedIn } from './session'

// Groups and their calendars with the real stack (design §8 "Groups"): alice (an administrator)
// makes a group and puts bob in it; bob (not an administrator) makes a calendar for the group and
// shares it with alice to read; the calendar reaches the members' homes in Radicale; Radicale lets
// alice read but not write, then write once bob changes the share to "Can edit"; deleting the
// calendar and the group removes everything again. Radicale is asked directly (it trusts
// X-Remote-User on this test network) for what the browser cannot show: who may write. The test
// removes what it made; a run that fails half-way leaves a group "e2e-crew-<number>" (alice can
// delete it, after its calendar).
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const GROUP = `e2e-crew-${STAMP}`
const CALENDAR = `E2E crew calendar ${STAMP}`
const RADICALE = 'http://radicale:5232'
const DB_PATH = '/tmp/e2e-live.db'
// The file Radicale of the test stack reads (playwright.live.config.ts points the app at it).
const GROUP_FILE = 'dev/spike-s1/.local/rules/groups'

let alice: Page
let bob: Page
let aliceProblems: string[] = []
let bobProblems: string[] = []
let aliceSub = ''
let bobSub = ''

function subOf(username: string): string {
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

/** A request to Radicale as `sub` (the test network trusts the header, as the app's gateway does). */
async function radicale(
  sub: string,
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${RADICALE}${path}`, {
    method,
    headers: { 'X-Remote-User': sub, ...init.headers },
    body: init.body,
  })
  return { status: response.status, text: await response.text() }
}

/** The path of the collection named `CALENDAR` in `sub`'s home, or null while it is not there. */
async function homeEntry(sub: string): Promise<string | null> {
  const home = await radicale(sub, 'PROPFIND', `/${sub}/`, {
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
  })
  if (home.status !== 207) return null
  for (const block of home.text.split(/<(?:\w+:)?response>/).slice(1)) {
    if (!block.includes(`>${CALENDAR}<`)) continue
    return /<(?:\w+:)?href>([^<]+)</.exec(block)?.[1] ?? null
  }
  return null
}

async function waitForEntry(sub: string, present: boolean): Promise<string | null> {
  let found: string | null = null
  await expect
    .poll(
      async () => {
        found = await homeEntry(sub)
        return found !== null
      },
      { timeout: 75_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(present)
  return found
}

const EVENT = (uid: string) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-calendar e2e//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261105T100000Z',
    'DTSTART:20261110T100000Z',
    'DTEND:20261110T110000Z',
    'SUMMARY:E2E groups probe',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')

/** PUT an event into the collection as `sub`; the status says whether the share allows writing. */
async function putEvent(sub: string, collection: string, uid: string): Promise<number> {
  return (
    await radicale(sub, 'PUT', `${collection}${uid}.ics`, {
      body: EVENT(uid),
      headers: { 'Content-Type': 'text/calendar' },
    })
  ).status
}

/** Chooses an option of a select menu: its trigger is a button named after the label. */
async function choose(page: Page, label: string, option: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click()
  await page.getByRole('option', { name: option }).click()
}

async function openGroupsPage(page: Page): Promise<void> {
  await page.goto('/groups')
  await expect(page.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible()
}

async function openGroup(page: Page): Promise<void> {
  await page.getByRole('button', { name: `Open ${GROUP}` }).click()
  await expect(page.getByRole('heading', { name: GROUP, level: 2 })).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  const first = await openSignedIn(browser, 'alice')
  alice = first.page
  aliceProblems = first.problems
  const second = await openSignedIn(browser, 'bob')
  bob = second.page
  bobProblems = second.problems
  aliceSub = subOf('alice')
  bobSub = subOf('bob')
})

test.afterAll(async () => {
  await alice.context().close()
  await bob.context().close()
  // The group file of the test stack goes back to empty (the sync keeps the last group otherwise).
  writeFileSync(GROUP_FILE, '')
})

test('alice creates the group and puts bob in it', async () => {
  await openGroupsPage(alice)
  await alice.getByLabel('Group name').fill(GROUP)
  await alice.getByRole('button', { name: 'Create group' }).click()
  await expect(alice.locator('[data-group]').filter({ hasText: GROUP })).toBeVisible()

  await openGroup(alice)
  await choose(alice, 'Person', /\(bob\)/)
  await alice
    .locator('form')
    .filter({ hasText: 'Add a member' })
    .getByRole('button', { name: 'Add', exact: true })
    .click()
  await alice.getByRole('button', { name: 'Save members' }).click()
  await expect(alice.getByRole('button', { name: 'Save members' })).toHaveCount(0)
  await expect(alice.getByText('Members of').first()).toBeVisible()
})

test('bob sees the group, without the controls of an administrator', async () => {
  await openGroupsPage(bob)
  await expect(bob.locator('[data-group]').filter({ hasText: GROUP })).toBeVisible()
  await expect(bob.getByRole('button', { name: 'Create group' })).toHaveCount(0)
  await openGroup(bob)
  await expect(bob.getByRole('button', { name: 'Save members' })).toHaveCount(0)
  await expect(bob.getByRole('button', { name: /^Remove / })).toHaveCount(0)
})

test('bob makes a calendar for the group and shares it with alice to read', async () => {
  const create = bob.locator('form').filter({ hasText: 'New calendar' })
  await create.getByLabel('Name').fill(CALENDAR)
  await bob.getByRole('button', { name: 'Add calendar' }).click()
  const calendars = bob.locator('[data-group-calendar]')
  await expect(calendars.filter({ hasText: CALENDAR })).toBeVisible()

  await bob.getByRole('button', { name: `Share ${CALENDAR}` }).click()
  const dialog = bob.getByRole('dialog')
  await choose(bob, 'Person', /\(alice\)/)
  await dialog.getByRole('radio', { name: 'Can view' }).check({ force: true })
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save sharing' }).click()
  await expect(dialog).toBeHidden()
  await expect(calendars.filter({ hasText: CALENDAR })).toContainText('Can view')
})

test('the calendar reaches the home of bob, a member, and of alice, who has a share', async () => {
  const bobs = await waitForEntry(bobSub, true)
  const alices = await waitForEntry(aliceSub, true)
  expect(bobs).toMatch(new RegExp(`^/${bobSub}/shared-`))
  expect(alices).toMatch(new RegExp(`^/${aliceSub}/shared-`))
})

test('radicale lets bob write, and alice only read', async () => {
  const bobs = (await homeEntry(bobSub))!
  const alices = (await homeEntry(aliceSub))!
  const uid = `groups-probe-${STAMP}`
  expect(await putEvent(aliceSub, alices, `${uid}-alice`)).toBe(403)
  expect(await putEvent(bobSub, bobs, uid)).toBeLessThan(300)
  // The event bob wrote is readable by alice through her share.
  await expect
    .poll(async () => (await radicale(aliceSub, 'GET', `${alices}${uid}.ics`)).status, {
      timeout: 20_000,
    })
    .toBe(200)
})

test('both members see the calendar in their sidebar', async () => {
  for (const page of [alice, bob]) {
    await page.goto('/')
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await expect(page.getByText(CALENDAR, { exact: true }).first()).toBeVisible()
  }
})

test('bob changes the share of alice to "Can edit" and alice can write', async () => {
  await openGroupsPage(bob)
  await openGroup(bob)
  // The default calendar Radicale makes in every new home is not adopted as a group calendar.
  await expect(bob.locator('[data-group-calendar]')).toHaveCount(1)
  await bob.getByRole('button', { name: `Share ${CALENDAR}` }).click()
  const dialog = bob.getByRole('dialog')
  await dialog.getByRole('radio', { name: 'Can edit' }).check({ force: true })
  await choose(bob, 'Person', /\(alice\)/)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save sharing' }).click()
  await expect(dialog).toBeHidden()
  await expect(bob.locator('[data-group-calendar]').filter({ hasText: CALENDAR })).toContainText(
    'Can edit',
  )
  await expect
    .poll(
      async () => {
        const path = await homeEntry(aliceSub)
        return path ? await putEvent(aliceSub, path, `groups-probe-${STAMP}-alice`) : 0
      },
      { timeout: 75_000, intervals: [1000, 2000, 3000] },
    )
    .toBeLessThan(300)
})

test('deleting the calendar and the group removes them from every home', async () => {
  // Radicale drops the shares on the next sharing run, which can take a minute.
  test.setTimeout(150_000)
  await bob.getByRole('button', { name: `Delete ${CALENDAR}` }).click()
  await bob.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(bob.locator('[data-group-calendar]').filter({ hasText: CALENDAR })).toHaveCount(0)
  await waitForEntry(bobSub, false)
  await waitForEntry(aliceSub, false)

  await openGroupsPage(alice)
  await alice.getByRole('button', { name: `Delete group ${GROUP}` }).click()
  await alice.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(alice.locator('[data-group]').filter({ hasText: GROUP })).toHaveCount(0)
})

test('no script or console errors came up', () => {
  expect(aliceProblems).toEqual([])
  expect(bobProblems).toEqual([])
})
