import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { APP_ORIGIN, openSignedIn } from './session'

// The calendar of a resource in calendar apps (design §5), with the real stack: alice (an admin)
// makes a resource that she may book and bob may see (rules of their own: a rule for everyone
// reaches people through the group file, which the groups spec empties when it ends), and she books
// it for an event in her calendar. bob finds the resource's calendar in his home through the gateway, as a
// calendar app does, reads "Reserved by <alice's name>" there (tentative while pending), and cannot
// write it. Deactivated, the calendar leaves his home; reactivated, it comes back.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const CAR = `E2E car ${STAMP}`
const UID = `e2e-resource-${STAMP}`
const DB_PATH = '/tmp/e2e-live.db'

let alice: Page
let bob: Page
let aliceBearer = ''
let bobBearer = ''
let resourceId = 0
let bookingId = 0

function userOf(username: 'alice' | 'bob'): { sub: string; shown: string } {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('SELECT oidc_sub, name, username FROM users WHERE username = ?')
      .get(username) as { oidc_sub: string; name: string | null; username: string } | undefined
    if (!row) throw new Error(`${username} has not signed in`)
    return { sub: row.oidc_sub, shown: row.name?.trim() || row.username }
  } finally {
    db.close()
  }
}

/** The bearer token the app sends for this page's user. */
async function bearerOf(page: Page): Promise<string> {
  const request = page.waitForRequest(
    (candidate) => candidate.url().includes('/api/') && !!candidate.headers()['authorization'],
  )
  await page.goto('/')
  return (await request).headers()['authorization']!
}

/** What a calendar app sends: the gateway, with the person's own token. */
function dav(page: Page, bearer: string, method: string, path: string, body = '', depth = '1') {
  return page.request.fetch(`${APP_ORIGIN}/caldav${path}`, {
    method,
    headers: { authorization: bearer, depth, 'content-type': 'application/xml; charset=utf-8' },
    data: body,
  })
}

/** The collection names in bob's home, as a calendar app lists them. */
async function bobsCollections(): Promise<string[]> {
  const listing = await dav(
    bob,
    bobBearer,
    'PROPFIND',
    `/${userOf('bob').sub}/`,
    '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  )
  return [...(await listing.text()).matchAll(/<(?:\w+:)?href>([^<]+)</g)]
    .map((match) => decodeURIComponent(match[1]!).split('/').filter(Boolean).pop() ?? '')
    .filter(Boolean)
}

const carName = () => `resource-${resourceId}`

test.beforeAll(async ({ browser }) => {
  alice = (await openSignedIn(browser, 'alice')).page
  bob = (await openSignedIn(browser, 'bob')).page
  aliceBearer = await bearerOf(alice)
  bobBearer = await bearerOf(bob)
})

test.afterAll(async () => {
  if (bookingId) {
    await alice.request.post(
      `${APP_ORIGIN}/api/resources/${resourceId}/bookings/${bookingId}/cancel`,
      { headers: { authorization: aliceBearer } },
    )
  }
  await dav(alice, aliceBearer, 'DELETE', `/${userOf('alice').sub}/def-calendar/${UID}.ics`)
  // A resource with bookings is not deleted; deactivated, it is out of everyone's way.
  if (resourceId) {
    await alice.request.post(`${APP_ORIGIN}/api/admin/resources/${resourceId}/deactivate`, {
      headers: { authorization: aliceBearer },
    })
  }
  await alice.context().close()
  await bob.context().close()
})

test("a booked resource's calendar reaches the people who may see it, naming who booked", async () => {
  const made = await alice.request.post(`${APP_ORIGIN}/api/admin/resources`, {
    headers: { authorization: aliceBearer },
    data: { name: CAR, type: 'car' },
  })
  expect(made.status()).toBe(201)
  resourceId = ((await made.json()) as { id: number }).id
  const rules = await alice.request.put(`${APP_ORIGIN}/api/admin/resources/${resourceId}/acl`, {
    headers: { authorization: aliceBearer },
    data: {
      rules: [
        { principalType: 'user', principal: userOf('alice').sub, right: 'book' },
        { principalType: 'user', principal: userOf('bob').sub, right: 'read' },
      ],
    },
  })
  expect(rules.status()).toBe(200)

  // alice's event for tomorrow, in her own calendar, then her booking for it
  const day = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const at = (hour: string) => `${day.replace(/-/g, '')}T${hour}0000Z`
  const event = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//e2e//EN',
    'BEGIN:VEVENT',
    `UID:${UID}`,
    `DTSTAMP:${at('08')}`,
    `DTSTART:${at('10')}`,
    `DTEND:${at('11')}`,
    'SUMMARY:Customer visit',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
  const aliceSub = userOf('alice').sub
  const put = await alice.request.put(`${APP_ORIGIN}/caldav/${aliceSub}/def-calendar/${UID}.ics`, {
    headers: { authorization: aliceBearer, 'content-type': 'text/calendar; charset=utf-8' },
    data: event,
  })
  expect(put.status()).toBe(201)
  const booked = await alice.request.post(`${APP_ORIGIN}/api/resources/${resourceId}/bookings`, {
    headers: { authorization: aliceBearer },
    data: {
      startAt: `${day}T10:00:00.000Z`,
      endAt: `${day}T11:00:00.000Z`,
      eventCalendarPath: `/caldav/${aliceSub}/def-calendar/`,
      eventUid: UID,
    },
  })
  expect(booked.status()).toBe(201)
  bookingId = ((await booked.json()) as { id: number }).id

  // bob, who may see it, finds the car's calendar in his home
  await expect.poll(bobsCollections, { timeout: 30_000 }).toContain(carName())
  expect(await bobsCollections()).not.toContain('resource-availability')
  const query = await dav(
    bob,
    bobBearer,
    'REPORT',
    `/${userOf('bob').sub}/${carName()}/`,
    '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
      '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
      '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>' +
      '</C:calendar-query>',
  )
  expect(query.status()).toBe(207)
  const text = (await query.text()).replace(/\r?\n /g, '')
  expect(text).toContain(`SUMMARY:Reserved by ${userOf('alice').shown}`)
  expect(text).toContain('STATUS:TENTATIVE')
  // nothing of alice's event itself
  expect(text).not.toContain('Customer visit')
  expect(text).not.toContain(UID)

  // read-only for him: the gateway refuses before Radicale
  const write = await dav(
    bob,
    bobBearer,
    'PUT',
    `/${userOf('bob').sub}/${carName()}/mine.ics`,
    event.replace(UID, `${UID}-bob`),
    '0',
  )
  expect(write.status()).toBe(403)
})

test('a deactivated resource leaves the calendar apps, and comes back when reactivated', async () => {
  const off = await alice.request.post(
    `${APP_ORIGIN}/api/admin/resources/${resourceId}/deactivate`,
    { headers: { authorization: aliceBearer } },
  )
  expect(off.status()).toBe(200)
  await expect.poll(bobsCollections, { timeout: 30_000 }).not.toContain(carName())

  const on = await alice.request.put(`${APP_ORIGIN}/api/admin/resources/${resourceId}`, {
    headers: { authorization: aliceBearer },
    data: { active: true },
  })
  expect(on.status()).toBe(200)
  await expect.poll(bobsCollections, { timeout: 30_000 }).toContain(carName())
})
