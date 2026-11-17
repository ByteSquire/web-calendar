import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { APP_ORIGIN, openSignedIn } from './session'

// A calendar shared at "Busy times only" syncs in calendar apps as busy copies (design §8), with the
// real stack: alice (an admin) gives bob free/busy access to her first calendar and puts in a titled
// event with a place and a guest, a weekly series with a cancelled occurrence, and an event marked
// free. bob sends what Thunderbird and DAVx5 send through the gateway and gets "Busy" and nothing
// else; a title-only change keeps the sync token, a time change ends it. The web app's free/busy
// query still answers. The test puts alice's rules back and removes its events at the end.
test.describe.configure({ mode: 'serial' })

const DB_PATH = '/tmp/e2e-live.db'
const STAMP = Date.now()
const RADICALE = 'http://radicale:5232'

let alice: Page
let bob: Page
let aliceBearer = ''
let bobBearer = ''
let aliceSub = ''
let bobSub = ''
let calendarId = 0
let keep: { principalType: string; principal: string | null; permission: string }[] = []
const uids = [`busy-meeting-${STAMP}`, `busy-series-${STAMP}`, `busy-free-${STAMP}`]

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

function dav(page: Page, bearer: string, method: string, path: string, body = '', depth = '1') {
  return page.request.fetch(`${APP_ORIGIN}/caldav${path}`, {
    method,
    headers: { authorization: bearer, depth, 'content-type': 'application/xml; charset=utf-8' },
    data: body,
  })
}

async function api(method: string, path: string, data?: unknown) {
  return alice.request.fetch(`${APP_ORIGIN}${path}`, {
    method,
    headers: { authorization: aliceBearer, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  })
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')

function ics(...event: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//e2e//EN',
    ...event,
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

function meeting(title: string, hour: string): string {
  return ics(
    'BEGIN:VEVENT',
    `UID:${uids[0]}`,
    `DTSTAMP:${day(0)}T080000Z`,
    `DTSTART:${day(2)}T${hour}0000Z`,
    `DTEND:${day(2)}T${hour}3000Z`,
    `SUMMARY:${title}`,
    'LOCATION:Secret meeting room',
    'ATTENDEE;CN=Secret Guest:mailto:guest@secret.example.org',
    'END:VEVENT',
  )
}

const series = ics(
  'BEGIN:VEVENT',
  `UID:${uids[1]}`,
  `DTSTAMP:${day(0)}T080000Z`,
  `DTSTART:${day(3)}T070000Z`,
  'DURATION:PT1H',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Secret weekly',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `UID:${uids[1]}`,
  `DTSTAMP:${day(0)}T080000Z`,
  `RECURRENCE-ID:${day(10)}T070000Z`,
  `DTSTART:${day(10)}T070000Z`,
  'DURATION:PT1H',
  'STATUS:CANCELLED',
  'SUMMARY:Secret weekly',
  'END:VEVENT',
)

const free = ics(
  'BEGIN:VEVENT',
  `UID:${uids[2]}`,
  `DTSTAMP:${day(0)}T080000Z`,
  `DTSTART:${day(4)}T120000Z`,
  `DTEND:${day(4)}T130000Z`,
  'TRANSP:TRANSPARENT',
  'SUMMARY:Secret free time',
  'END:VEVENT',
)

const share = () => `/${bobSub}/shared-${calendarId}/`
const SYNC = (token: string) =>
  `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`
const hrefs = (xml: string) =>
  [...xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map((m) => m[1]!)

async function put(body: string, uid: string) {
  const response = await alice.request.put(
    `${APP_ORIGIN}/caldav/${aliceSub}/def-calendar/${uid}.ics`,
    { headers: { authorization: aliceBearer, 'content-type': 'text/calendar' }, data: body },
  )
  expect([201, 204]).toContain(response.status())
}

/** Whether Radicale lists the share in bob's home, as a calendar app finds it. */
async function listedForBob(): Promise<boolean> {
  const response = await fetch(`${RADICALE}/${encodeURIComponent(bobSub)}/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': bobSub, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  })
  return (await response.text()).includes(`/shared-${calendarId}/`)
}

test.beforeAll(async ({ browser }) => {
  alice = (await openSignedIn(browser, 'alice')).page
  bob = (await openSignedIn(browser, 'bob')).page
  aliceBearer = await bearerOf(alice)
  bobBearer = await bearerOf(bob)
  aliceSub = row<{ sub: string }>("SELECT oidc_sub AS sub FROM users WHERE username = 'alice'").sub
  bobSub = row<{ sub: string }>("SELECT oidc_sub AS sub FROM users WHERE username = 'bob'").sub
  calendarId = row<{ id: number }>(
    'SELECT id FROM calendars WHERE collection_path = ?',
    `/${aliceSub}/def-calendar/`,
  ).id
  const listed = (await (await api('GET', '/api/admin/access/calendars')).json()) as {
    calendars: { id: number; rules: typeof keep }[]
  }
  keep = listed.calendars
    .find((calendar) => calendar.id === calendarId)!
    .rules.map(({ principalType, principal, permission }) => ({
      principalType,
      principal,
      permission,
    }))
})

test.afterAll(async () => {
  for (const uid of uids) {
    await dav(alice, aliceBearer, 'DELETE', `/${aliceSub}/def-calendar/${uid}.ics`, '', '0')
  }
  if (calendarId) {
    await api('PUT', `/api/admin/access/calendars/${calendarId}`, { rules: keep })
    await expect.poll(listedForBob, { timeout: 30_000 }).toBe(false)
  }
  await alice.context().close()
  await bob.context().close()
})

test('bob syncs alice’s calendar shared at busy times only, and gets nothing but “Busy”', async () => {
  const saved = await api('PUT', `/api/admin/access/calendars/${calendarId}`, {
    rules: [...keep, { principalType: 'user', principal: bobSub, permission: 'free_busy' }],
  })
  expect(saved.status()).toBe(200)
  await put(meeting('Secret board meeting', '09'), uids[0]!)
  await put(series, uids[1]!)
  await put(free, uids[2]!)
  await expect.poll(listedForBob, { timeout: 30_000 }).toBe(true)

  // What a calendar app does: the collection, then the list, then the entries.
  const collection = await dav(bob, bobBearer, 'PROPFIND', share(), '', '0')
  expect(collection.status()).toBe(207)
  expect(await collection.text()).toContain('/sync/busy/')
  const first = await dav(bob, bobBearer, 'REPORT', share(), SYNC(''))
  expect(first.status()).toBe(207)
  const firstText = await first.text()
  const token = /<(?:\w+:)?sync-token>([^<]+)</.exec(firstText)![1]!
  const entries = hrefs(firstText)
  // the series and the meeting; the event marked free is left out, as free/busy leaves it out
  expect(entries.length).toBeGreaterThanOrEqual(2)
  const multiget = await dav(
    bob,
    bobBearer,
    'REPORT',
    share(),
    `<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop>${entries.map((href) => `<D:href>${href}</D:href>`).join('')}</C:calendar-multiget>`,
  )
  const data = (await multiget.text()).replace(/\r?\n /g, '')
  expect(data).toContain('SUMMARY:Busy')
  expect(data).toContain('RRULE:FREQ=WEEKLY;COUNT=4')
  expect(data).toContain(`EXDATE:${day(10)}T070000Z`)
  // the event marked free is left out, as free/busy leaves it out
  expect(data).not.toContain(`${day(4)}T120000Z`)
  for (const secret of ['Secret', 'secret.example.org', ...uids]) {
    expect(data).not.toContain(secret)
  }
  // writes stay refused
  expect(
    (await dav(bob, bobBearer, 'PUT', `${share()}x.ics`, meeting('Mine', '10'), '0')).status(),
  ).toBe(403)

  // The web app's free/busy query still goes to Radicale and answers.
  const freeBusy = await dav(
    bob,
    bobBearer,
    'REPORT',
    share(),
    `<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:time-range start="${day(0)}T000000Z" end="${day(30)}T000000Z"/></C:free-busy-query>`,
  )
  expect(freeBusy.status()).toBe(200)
  expect(await freeBusy.text()).toContain('VFREEBUSY')

  // A new title keeps the token; a new time ends it, and the app starts over.
  await put(meeting('Renamed secret board meeting', '09'), uids[0]!)
  const same = await dav(bob, bobBearer, 'REPORT', share(), SYNC(token))
  expect(same.status()).toBe(207)
  expect(hrefs(await same.text())).toHaveLength(0)
  await put(meeting('Renamed secret board meeting', '11'), uids[0]!)
  expect((await dav(bob, bobBearer, 'REPORT', share(), SYNC(token))).status()).toBe(403)
})
