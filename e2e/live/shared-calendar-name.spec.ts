import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { APP_ORIGIN, openSignedIn } from './session'

// A person's calendar shared with someone must not look like their own. With the real stack: alice
// (an admin) gives bob "Can edit" on her first calendar through an access rule. The app names each
// person's first calendar after them (Radicale calls them all "Personal Calendar"), so bob's sidebar
// and the calendar choice of "Add" list his own under his name and alice's under hers, and an event
// saved in hers lands there. The test puts alice's rules back at the end; a run that fails half-way
// can leave the rule behind.
test.describe.configure({ mode: 'serial' })

const DB_PATH = '/tmp/e2e-live.db'
const RADICALE = 'http://radicale:5232'
const TITLE = `E2E shared name ${Date.now()}`

let alice: Page
let bob: Page
let aliceBearer = ''
let calendarId = 0
let keep: { principalType: string; principal: string | null; permission: string }[] = []
let ownerName = ''
let bobName = ''
let bobSub = ''

/** Whether Radicale lists alice's calendar in bob's home (it trusts X-Remote-User on this network). */
async function sharedWithBob(): Promise<boolean> {
  const response = await fetch(`${RADICALE}/${encodeURIComponent(bobSub)}/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': bobSub, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  })
  return (await response.text()).includes(`/shared-${calendarId}`)
}

function row<T>(sql: string, ...params: unknown[]): T {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(sql).get(...params) as T
  } finally {
    db.close()
  }
}

async function bearerOf(page: Page): Promise<string> {
  const request = page.waitForRequest(
    (candidate) => candidate.url().includes('/api/') && !!candidate.headers()['authorization'],
  )
  await page.goto('/')
  return (await request).headers()['authorization']!
}

async function api(method: string, path: string, data?: unknown) {
  const response = await alice.request.fetch(`${APP_ORIGIN}${path}`, {
    method,
    headers: { authorization: aliceBearer, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  })
  return { status: response.status(), body: (await response.json().catch(() => null)) as unknown }
}

test.beforeAll(async ({ browser }) => {
  alice = (await openSignedIn(browser, 'alice')).page
  bob = (await openSignedIn(browser, 'bob')).page
  aliceBearer = await bearerOf(alice)
  const owner = row<{ id: number; sub: string; name: string | null; username: string }>(
    "SELECT id, oidc_sub AS sub, name, username FROM users WHERE username = 'alice'",
  )
  ownerName = owner.name || owner.username
  const bobRow = row<{ sub: string; name: string | null; username: string }>(
    "SELECT oidc_sub AS sub, name, username FROM users WHERE username = 'bob'",
  )
  bobSub = bobRow.sub
  bobName = bobRow.name || bobRow.username
  calendarId = row<{ id: number }>(
    'SELECT id FROM calendars WHERE collection_path = ?',
    `/${owner.sub}/def-calendar/`,
  ).id
  const listed = await api('GET', '/api/admin/access/calendars')
  const current = (
    listed.body as { calendars: { id: number; rules: typeof keep }[] }
  ).calendars.find((calendar) => calendar.id === calendarId)!
  keep = current.rules.map(({ principalType, principal, permission }) => ({
    principalType,
    principal,
    permission,
  }))
})

test.afterAll(async () => {
  if (calendarId) {
    await api('PUT', `/api/admin/access/calendars/${calendarId}`, { rules: keep })
    // The next spec must not find the share still in Radicale (its reads would be refused).
    await expect.poll(sharedWithBob, { timeout: 30_000 }).toBe(false)
  }
  await alice.context().close()
  await bob.context().close()
})

test('bob sees alice’s calendar named with its owner, apart from his own', async () => {
  const saved = await api('PUT', `/api/admin/access/calendars/${calendarId}`, {
    rules: [...keep, { principalType: 'user', principal: bobSub, permission: 'write' }],
  })
  expect(saved.status).toBe(200)
  // her calendar is named after her, so the owner is not named twice
  const shared = ownerName
  // the sharing writer maps it into bob's home shortly
  await expect
    .poll(
      async () => {
        await bob.reload()
        // the calendars are listed once his own is there
        await expect(bob.getByRole('switch', { name: bobName, exact: true })).toBeVisible()
        return bob.getByRole('switch', { name: shared, exact: true }).count()
      },
      { timeout: 40_000 },
    )
    .toBe(1)
  await expect(bob.getByRole('switch', { name: bobName, exact: true })).toHaveCount(1)
})

test('"Add" offers both by those names, and an event saved in alice’s lands there', async () => {
  await bob.getByRole('button', { name: 'Add', exact: true }).click()
  const dialog = bob.getByRole('dialog', { name: 'Add event' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Title').fill(TITLE)
  await dialog.getByLabel('Calendar').click()
  const options = bob.getByRole('option')
  await expect(options.filter({ hasText: new RegExp(`^(${bobName}|${ownerName})$`) })).toHaveText([
    bobName,
    ownerName,
  ])
  await bob.getByRole('option', { name: ownerName, exact: true }).click()
  await dialog.getByRole('button', { name: 'Add event' }).click()
  await expect(dialog).toBeHidden()
  // alice finds it in her own calendar
  await expect
    .poll(
      async () => {
        await alice.reload()
        // the events are drawn a moment after the page
        return alice
          .locator('[data-calendar-main]')
          .getByText(TITLE)
          .first()
          .waitFor({ timeout: 5_000 })
          .then(
            () => true,
            () => false,
          )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  // and removes it again
  await alice.locator('[data-calendar-main]').getByText(TITLE).first().click()
  const sheet = alice.getByRole('dialog', { name: TITLE })
  await sheet.getByRole('button', { name: 'Delete' }).click()
  const confirm = alice.getByRole('dialog', { name: `Delete "${TITLE}"?` })
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(alice.locator('[data-calendar-main]').getByText(TITLE)).toHaveCount(0)
})
