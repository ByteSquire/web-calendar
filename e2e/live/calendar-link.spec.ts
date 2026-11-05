import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { scan } from '../axe-scan'
import { APP_ORIGIN, newAppContext, openSignedIn } from './session'

// Calendar links with the real stack (design S8 setup): alice makes a password-protected, read-only
// link to one of her calendars on the Settings page; a visitor without an account opens it, is
// refused with a wrong password, sees the calendar alone with the right one (titles and places, no
// descriptions, a private event as busy, no sidebar, no adding, a menu of looks only), and loses it
// when alice withdraws the link. The calendar and its events are put into Radicale directly (it
// trusts X-Remote-User on this test network) and removed at the end; a run that fails half-way
// leaves "E2E link calendar <number>" behind.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const CALENDAR = `E2E link calendar ${STAMP}`
const COLLECTION = `e2e-link-${STAMP}`
const RADICALE = 'http://radicale:5232'
const DB_PATH = '/tmp/e2e-live.db'
const PASSWORD = `link password ${STAMP}`
const LABEL = `For the parents ${STAMP}`

let alice: Page
let aliceProblems: string[] = []
let visitor: Page
const visitorProblems: string[] = []
/** Every address the visitor's page asked for: it must never leave the app. */
const visitorRequests: string[] = []
let address = ''

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

const aliceSub = () => subOf('alice')

function collectionPathOf(calendarId: number): string {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('SELECT collection_path FROM calendars WHERE id = ?')
      .get(calendarId) as {
      collection_path: string
    }
    return row.collection_path
  } finally {
    db.close()
  }
}

/** The bearer token the app sends for `page` (it is kept in memory, so it is read off a request). */
async function bearerOf(page: Page): Promise<string> {
  const request = page.waitForRequest(
    (candidate) => candidate.url().includes('/api/') && !!candidate.headers()['authorization'],
  )
  await page.goto('/')
  return (await request).headers()['authorization']!
}

async function api(page: Page, bearer: string, method: string, path: string, data?: unknown) {
  const response = await page.request.fetch(`${APP_ORIGIN}${path}`, {
    method,
    headers: { authorization: bearer, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  })
  return { status: response.status(), body: (await response.json().catch(() => null)) as unknown }
}

/** The path under which a calendar named `name` is in the home of `sub` (a share is mapped there). */
async function pathInHome(sub: string, name: string): Promise<string | null> {
  const response = await fetch(`${RADICALE}/${encodeURIComponent(sub)}/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': sub, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  })
  for (const block of (await response.text()).split(/<(?:\w+:)?response>/).slice(1)) {
    if (!block.includes(`>${name}<`)) continue
    const href = /<(?:\w+:)?href>([^<]+)</.exec(block)?.[1]
    return href ? decodeURIComponent(href) : null
  }
  return null
}

async function radicale(
  method: string,
  path: string,
  body?: string,
  extra: Record<string, string> = {},
) {
  const sub = aliceSub()
  const response = await fetch(`${RADICALE}/${encodeURIComponent(sub)}/${path}`, {
    method,
    headers: { 'X-Remote-User': sub, ...extra },
    body,
  })
  return response.status
}

/** Today at `hour` in Berlin, as a floating iCalendar time with its zone. */
function todayAt(hour: number): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
  return `${date.replace(/-/g, '')}T${String(hour).padStart(2, '0')}0000`
}

function event(uid: string, lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//e2e//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261101T080000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

async function openVisitor(browser: Browser): Promise<void> {
  const context = await newAppContext(browser)
  visitor = await context.newPage()
  visitor.on('request', (request) => visitorRequests.push(request.url()))
  visitor.on('pageerror', (error) => visitorProblems.push(`pageerror: ${error.message}`))
  visitor.on('console', (message) => {
    if (message.type() !== 'error') return
    // The wrong password and the withdrawn link answer 401 and 404 on purpose.
    if (
      /Failed to load resource: the server responded with a status of (401|404)/.test(
        message.text(),
      )
    )
      return
    visitorProblems.push(`console: ${message.text()}`)
  })
}

test.beforeAll(async ({ browser }) => {
  const session = await openSignedIn(browser, 'alice')
  alice = session.page
  aliceProblems = session.problems
  expect(
    await radicale(
      'MKCALENDAR',
      `${COLLECTION}/`,
      `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>${CALENDAR}</D:displayname></D:prop></D:set></C:mkcalendar>`,
      { 'Content-Type': 'application/xml' },
    ),
  ).toBe(201)
  const ics = { 'Content-Type': 'text/calendar; charset=utf-8' }
  expect(
    await radicale(
      'PUT',
      `${COLLECTION}/planning.ics`,
      event(`planning-${STAMP}`, [
        `DTSTART;TZID=Europe/Berlin:${todayAt(10)}`,
        `DTEND;TZID=Europe/Berlin:${todayAt(11)}`,
        'SUMMARY:Team planning',
        'LOCATION:Room 4',
        'DESCRIPTION:Secret budget numbers',
        'ATTENDEE;CN=Anna:mailto:anna@example.org',
      ]),
      ics,
    ),
  ).toBe(201)
  expect(
    await radicale(
      'PUT',
      `${COLLECTION}/doctor.ics`,
      event(`doctor-${STAMP}`, [
        `DTSTART;TZID=Europe/Berlin:${todayAt(14)}`,
        `DTEND;TZID=Europe/Berlin:${todayAt(15)}`,
        'SUMMARY:Doctor appointment',
        'CLASS:PRIVATE',
      ]),
      ics,
    ),
  ).toBe(201)
})

test.afterAll(async () => {
  await radicale('DELETE', `${COLLECTION}/`)
  await alice.context().close()
  await visitor?.context().close()
})

test('alice makes a link to her calendar on the Settings page and sees its address once', async () => {
  await alice.goto('/settings')
  const section = alice
    .locator('section')
    .filter({ has: alice.getByRole('heading', { name: 'Calendar links' }) })
  await expect(section).toBeVisible()
  await section.getByRole('combobox', { name: /^Calendar/ }).click()
  await alice.getByRole('option', { name: CALENDAR }).click()
  await section.getByRole('textbox', { name: /^Label/ }).fill(LABEL)
  await section.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD)
  await section.getByRole('button', { name: 'Make link' }).click()
  const field = section.getByRole('textbox', { name: /^Address/ })
  await expect(field).toBeVisible()
  address = await field.inputValue()
  expect(address).toMatch(new RegExp(`^${APP_ORIGIN}/link/[A-Za-z0-9_-]{43}$`))
  const { violations } = await new AxeBuilder({ page: alice })
    .include('section:has(#settings-links)')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(violations.map((violation) => violation.id)).toEqual([])
  await section.getByRole('button', { name: 'Done' }).click()
  await expect(section.getByText(LABEL)).toBeVisible()
  await expect(section.getByRole('textbox', { name: /^Address/ })).toHaveCount(0)
})

test('a visitor is asked for the password and refused with a wrong one', async ({ browser }) => {
  await openVisitor(browser)
  await visitor.goto(address)
  await expect(visitor.getByRole('heading', { name: 'A shared calendar' })).toBeVisible()
  // No sign-in was asked for: the page is the app's own, not the identity provider's.
  expect(new URL(visitor.url()).origin).toBe(APP_ORIGIN)
  const { violations } = await new AxeBuilder({ page: visitor })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(violations.map((violation) => violation.id)).toEqual([])
  await visitor.getByRole('textbox', { name: /^Password/ }).fill('not the password')
  await visitor.getByRole('button', { name: 'Open calendar' }).click()
  await expect(visitor.getByRole('alert')).toContainText('The password is not right.')
})

test('with the right password the visitor sees the calendar alone, read-only', async () => {
  await visitor.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD)
  await visitor.getByRole('button', { name: 'Open calendar' }).click()
  const main = visitor.locator('[data-calendar-main]')
  await expect(main).toBeVisible()
  await visitor.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(main).toContainText('Team planning')
  // the private event is there as busy, without its title
  await expect(main).toContainText('Busy')
  await expect(main).not.toContainText('Doctor')
  // nothing of the app around it
  await expect(visitor.locator('#app-sidebar')).toHaveCount(0)
  await expect(visitor.getByRole('button', { name: /sidebar/i })).toHaveCount(0)
  await expect(visitor.getByRole('button', { name: 'Quick add' })).toHaveCount(0)
  await expect(visitor.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
  // the event sheet shows the title and the place, no description, no Edit
  await main.getByText('Team planning').first().click()
  const sheet = visitor.getByRole('dialog')
  await expect(sheet).toContainText('Room 4')
  await expect(sheet).not.toContainText('Secret budget')
  await expect(sheet).not.toContainText('anna@')
  await expect(sheet.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await visitor.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  // the menu holds the look only
  await visitor.getByRole('button', { name: 'More options' }).click()
  const items = await visitor.getByRole('menuitemcheckbox').allInnerTexts()
  expect(items.join(' ')).toContain('Dark mode')
  expect(items.join(' ')).toContain('Deutsch')
  await expect(visitor.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0)
  await expect(visitor.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0)
  await visitor.keyboard.press('Escape')
  // The scan waits for the menu to have gone (it waits for animations), and FullCalendar's own grid
  // has known gaps (e2e/axe-scan.ts).
  await expect(visitor.getByRole('menu')).toHaveCount(0)
  expect(await scan(visitor)).toEqual([])
})

test('a reload in the same tab keeps the calendar open', async () => {
  await visitor.reload()
  await expect(visitor.locator('[data-calendar-main]')).toBeVisible()
  await expect(visitor.getByRole('heading', { name: 'A shared calendar' })).toHaveCount(0)
})

test('the page asks nothing of the identity provider, and works while it is down', async ({
  browser,
}) => {
  const context: BrowserContext = await newAppContext(browser)
  await context.route(/idm\.localhost/, (route) => route.abort())
  const page = await context.newPage()
  const asked: string[] = []
  page.on('request', (request) => asked.push(request.url()))
  try {
    await page.goto(address)
    await page.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Open calendar' }).click()
    await page.getByRole('button', { name: 'Day', exact: true }).click()
    await expect(page.locator('[data-calendar-main]')).toContainText('Team planning')
    expect(asked.filter((url) => !url.startsWith(APP_ORIGIN) && !url.startsWith('data:'))).toEqual(
      [],
    )
  } finally {
    await context.close()
  }
})

test('when alice withdraws the link the visitor loses it at once', async () => {
  await alice.reload()
  await alice.getByRole('button', { name: `Withdraw link ${LABEL}` }).click()
  await alice.getByRole('dialog').getByRole('button', { name: 'Withdraw link' }).click()
  await expect(alice.getByText(`Link “${LABEL}” withdrawn.`)).toBeVisible()
  // the next read of the open page fails, and the page says why
  await visitor.reload()
  await expect(
    visitor.getByText('This link does not exist, was withdrawn or does not work at the moment.'),
  ).toBeVisible()
  await expect(visitor.locator('[data-calendar-main]')).toHaveCount(0)
})

test('the visitor’s page asked only the app, nothing else', () => {
  expect(visitorRequests.length).toBeGreaterThan(0)
  expect(
    visitorRequests.filter((url) => !url.startsWith(APP_ORIGIN) && !url.startsWith('data:')),
  ).toEqual([])
})

// A link shows what its maker can see, read as the maker: it ends when the maker's access ends. bob
// makes a calendar for a group and shares it with alice to read; alice links it; bob takes the
// share back, and the link stops as soon as the sharing writer has removed the share in Radicale.
test.describe('a link to a calendar shared with its maker', () => {
  const GROUP = `e2e_link_${STAMP}`
  const SHARED = `E2E link shared ${STAMP}`
  let bob: Page
  let aliceBearer = ''
  let bobBearer = ''
  let groupId = 0
  let calendarId = 0
  let linkId = 0
  let slug = ''

  test.beforeAll(async ({ browser }) => {
    bob = (await openSignedIn(browser, 'bob')).page
    aliceBearer = await bearerOf(alice)
    bobBearer = await bearerOf(bob)
  })

  test.afterAll(async () => {
    if (linkId) await api(alice, aliceBearer, 'DELETE', `/api/calendar-links/${linkId}`)
    if (calendarId) {
      await api(bob, bobBearer, 'DELETE', `/api/groups/${groupId}/calendars/${calendarId}`)
    }
    if (groupId) await api(alice, aliceBearer, 'DELETE', `/api/groups/${groupId}`)
    await bob.context().close()
  })

  test('alice links a group calendar that bob shared with her to read', async () => {
    const group = await api(alice, aliceBearer, 'POST', '/api/groups', { name: GROUP })
    expect(group.status).toBe(201)
    groupId = (group.body as { group: { id: number } }).group.id
    const members = await api(alice, aliceBearer, 'PUT', `/api/groups/${groupId}/members`, {
      members: [subOf('bob')],
    })
    expect(members.status).toBe(200)
    const made = await api(bob, bobBearer, 'POST', `/api/groups/${groupId}/calendars`, {
      name: SHARED,
    })
    expect(made.status).toBe(201)
    calendarId = (made.body as { calendar: { id: number } }).calendar.id
    const groupPath = collectionPathOf(calendarId)
    const principal = groupPath.split('/')[1]!
    const put = await fetch(`${RADICALE}${groupPath}shared-event.ics`, {
      method: 'PUT',
      headers: { 'X-Remote-User': principal, 'Content-Type': 'text/calendar; charset=utf-8' },
      body: event(`shared-${STAMP}`, [
        `DTSTART;TZID=Europe/Berlin:${todayAt(12)}`,
        `DTEND;TZID=Europe/Berlin:${todayAt(13)}`,
        'SUMMARY:Shared lunch',
      ]),
    })
    expect(put.status).toBe(201)
    const shared = await api(
      bob,
      bobBearer,
      'PUT',
      `/api/groups/${groupId}/calendars/${calendarId}/shares`,
      { shares: [{ principalType: 'user', principal: aliceSub(), permission: 'read' }] },
    )
    expect(shared.status).toBe(200)
    // the sharing writer maps the calendar into alice's home
    let mapped: string | null = null
    await expect
      .poll(async () => (mapped = await pathInHome(aliceSub(), SHARED)), { timeout: 30_000 })
      .not.toBeNull()
    const href = `/caldav${mapped!.split('/').map(encodeURIComponent).join('/')}`
    const link = await api(alice, aliceBearer, 'POST', '/api/calendar-links', {
      calendarHref: href,
      password: PASSWORD,
    })
    expect(link.status).toBe(201)
    const created = link.body as { slug: string; link: { id: number } }
    slug = created.slug
    linkId = created.link.id
  })

  async function readAsVisitor(): Promise<number> {
    const session = await visitor.request.post(`${APP_ORIGIN}/api/link/${slug}/session`, {
      data: { password: PASSWORD },
    })
    if (session.status() !== 200) return session.status()
    const { token } = (await session.json()) as { token: string }
    const from = new Date(Date.now() - 86_400_000).toISOString()
    const to = new Date(Date.now() + 86_400_000).toISOString()
    const events = await visitor.request.get(
      `${APP_ORIGIN}/api/link/${slug}/events?from=${from}&to=${to}`,
      { headers: { 'x-calendar-link-session': token } },
    )
    if (events.status() !== 200) return events.status()
    const body = (await events.json()) as { objects: { data: string }[] }
    return body.objects.some((object) => object.data.includes('Shared lunch')) ? 200 : 204
  }

  test('a visitor sees the shared calendar through the link', async () => {
    expect(await readAsVisitor()).toBe(200)
  })

  test('when bob takes the share back, the link stops', async () => {
    const unshared = await api(
      bob,
      bobBearer,
      'PUT',
      `/api/groups/${groupId}/calendars/${calendarId}/shares`,
      { shares: [] },
    )
    expect(unshared.status).toBe(200)
    await expect.poll(() => readAsVisitor(), { timeout: 30_000 }).toBe(404)
  })
})

test('no script or console errors came up', () => {
  expect(aliceProblems).toEqual([])
  expect(visitorProblems).toEqual([])
})
