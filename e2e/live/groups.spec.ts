import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { readFileSync, writeFileSync } from 'node:fs'
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
  // The group file of the test stack goes back to empty (the app writes it again at its next change).
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
  // bob manages the group's calendars: only an administrator names a manager.
  await alice
    .getByRole('button', { name: new RegExp(`^Make manager of ${GROUP}: .*\\(bob\\)$`) })
    .click()
  await expect(
    alice.getByRole('button', { name: new RegExp(`^Remove as manager of ${GROUP}: .*\\(bob\\)$`) }),
  ).toBeVisible()
})

test('bob sees the group he manages, without the controls of an administrator', async () => {
  await openGroupsPage(bob)
  await expect(bob.locator('[data-group]').filter({ hasText: GROUP })).toContainText(
    'You manage this group',
  )
  await expect(bob.getByRole('button', { name: 'Create group' })).toHaveCount(0)
  await openGroup(bob)
  await expect(bob.getByRole('button', { name: 'Save members' })).toHaveCount(0)
  // a manager is not removed by another manager, nor named by one
  await expect(bob.getByRole('button', { name: /^Remove .*\(bob\) from/ })).toHaveCount(0)
  await expect(bob.getByRole('button', { name: /^Make / })).toHaveCount(0)
})

test('bob, a manager, makes a calendar for the group and shares it with alice to read', async () => {
  const create = bob.locator('form').filter({ hasText: 'New calendar' })
  await create.getByLabel('Name').fill(CALENDAR)
  // The form's own button: the sidebar has an "Add calendar" plus of its own, for personal calendars.
  await create.getByRole('button', { name: 'Add calendar' }).click()
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

test('bob, its manager, edits it from "Edit calendar" in his sidebar, staying in the calendar', async () => {
  await bob
    .locator('#app-sidebar')
    .getByRole('button', { name: new RegExp(`^Actions for calendar ${CALENDAR}`) })
    .first()
    .click()
  await bob.getByRole('menuitem', { name: 'Edit calendar' }).click()
  const editor = bob.getByRole('dialog', { name: CALENDAR })
  await expect(editor).toContainText(`A calendar of the group ${GROUP}.`)
  await expect(bob).toHaveURL(/\/$/)
  // its sharing, as the Groups page words it, and the share dialog over this one
  await expect(editor).toContainText('Can view')
  await editor.getByRole('button', { name: 'Change sharing' }).click()
  const share = bob.getByRole('dialog', { name: `Share ${CALENDAR}` })
  await expect(share).toBeVisible()
  await share.getByRole('button', { name: 'Cancel' }).click()
  await expect(share).toBeHidden()
  // a new colour, saved in Radicale and shown in the sidebar
  await editor.getByText('Red', { exact: true }).click()
  const saved = bob.waitForResponse(
    (response) => response.url().includes('/calendars/') && response.request().method() === 'PATCH',
  )
  await editor.getByRole('button', { name: 'Save changes' }).click()
  expect((await saved).status()).toBe(200)
  await expect(editor).toContainText(`${CALENDAR} was saved.`)
  await editor.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(editor).toBeHidden()
  await expect(bob.locator('[data-calendar-main]')).toBeVisible()
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

// A group of the identity provider (the test stack's Kanidm has `idp_team` with bob in it, made by
// `./spike.sh bootstrap`): the groups claim of bob's sign-in made it a candidate, alice imports it
// on the Groups page, and bob becomes a member at his next /api/me; the group file then lists him.
const IDP_GROUP = 'idp_team'

function groupFileLine(name: string): string | undefined {
  return readFileSync(GROUP_FILE, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${name}:`))
}

test('alice is offered the group of the identity provider, and not Kanidm’s own groups', async () => {
  await openGroupsPage(alice)
  const section = alice.locator('[data-oidc-groups]')
  await expect(section.locator('[data-oidc-group]').filter({ hasText: IDP_GROUP })).toBeVisible()
  await expect(section.locator('[data-oidc-group]').filter({ hasText: IDP_GROUP })).toContainText(
    'Not imported',
  )
  // The built-in groups (idm_*), the admin group and the group of everyone are never candidates.
  const names = await section.locator('[data-oidc-group] .font-medium').allTextContents()
  expect(names.filter((name) => /^(idm_|system_|domain_)/.test(name))).toEqual([])
  expect(names).not.toContain('calendar_admins')
  expect(names).not.toContain('web_calendar_users')
})

test('nobody is in the file for the group before it is imported', () => {
  expect(groupFileLine(IDP_GROUP)).toBeUndefined()
})

test('alice imports it, and bob is a member when he opens the page, and in the group file', async () => {
  const section = alice.locator('[data-oidc-groups]')
  await alice.getByRole('button', { name: `Import ${IDP_GROUP}`, exact: true }).click()
  await expect(section.locator('[data-oidc-group]').filter({ hasText: IDP_GROUP })).toContainText(
    'Imported',
  )
  await expect(alice.locator('[data-group]').filter({ hasText: IDP_GROUP })).toContainText(
    'From your identity provider',
  )

  // Opening the page asks /api/me, which reads bob's groups from Kanidm and joins him.
  await openGroupsPage(bob)
  const row = bob.locator('[data-group]').filter({ hasText: IDP_GROUP })
  await expect(row).toBeVisible()
  await expect(row).toContainText('You are a member')
  await expect
    .poll(() => groupFileLine(IDP_GROUP), { timeout: 20_000 })
    .toBe(`${IDP_GROUP}: ${bobSub}`)
  // The group of everyone lists both people who signed in.
  await expect
    .poll(() => groupFileLine('web_calendar_users'), { timeout: 20_000 })
    .toContain(bobSub)
  expect(groupFileLine('web_calendar_users')).toContain(aliceSub)

  // The group is read-only for its members: no member controls, only the note.
  await bob.getByRole('button', { name: `Open ${IDP_GROUP}` }).click()
  await expect(bob.locator('[data-imported-note]')).toBeVisible()
  await expect(bob.getByRole('button', { name: 'Save members' })).toHaveCount(0)
})

test('alice stops importing it, and the group is gone from the app and from the file', async () => {
  await openGroupsPage(alice)
  const section = alice.locator('[data-oidc-groups]')
  await alice.getByRole('button', { name: `Stop importing ${IDP_GROUP}`, exact: true }).click()
  await alice.getByRole('dialog').getByRole('button', { name: 'Stop importing' }).click()
  await expect(section.locator('[data-oidc-group]').filter({ hasText: IDP_GROUP })).toContainText(
    'Not imported',
  )
  await expect(alice.locator('[data-group]').filter({ hasText: IDP_GROUP })).toHaveCount(0)
  await expect.poll(() => groupFileLine(IDP_GROUP), { timeout: 20_000 }).toBeUndefined()
})

test('no script or console errors came up', () => {
  expect(aliceProblems).toEqual([])
  expect(bobProblems).toEqual([])
})
