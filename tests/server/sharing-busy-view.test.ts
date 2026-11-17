// @vitest-environment node
// The gateway's answer for a calendar shared at "Busy times only" (design §8): which share names it
// takes, what it reads as the owner, what calendar apps get (PROPFIND, sync-collection, multiget,
// calendar-query, GET), and that everything else still goes to Radicale as the caller.
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addCalendarAcl } from '../../server/db/calendar-acl'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { createGateway } from '../../server/utils/gateway/gateway'
import type { StoreSend } from '../../server/utils/resources/reconcile-reader'
import { createBusyView, requestedProps } from '../../server/utils/sharing/busy-view'
import { parseGroupFile, type GroupMembership } from '../../server/utils/sharing/membership'
import { createPathPrecheck } from '../../server/utils/sharing/precheck'

const ALICE = '8f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77'
const BOB = '3d9a7e51-0c2b-4f86-b1aa-6e4d8c0f9a12'
const EVE = '5b2e9c14-6a3d-4e08-8f71-2c9d4a7b1e30'

const members = parseGroupFile(`web_calendar_users: ${ALICE} ${BOB} ${EVE}\nteam: ${BOB}\n`)
const membership: GroupMembership = {
  groupsOf: async (sub) => members.get(sub) ?? new Set<string>(),
  all: async () => members,
}

const event = (uid: string, title: string, start: string) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${start}`,
    'DURATION:PT1H',
    `SUMMARY:${title}`,
    'LOCATION:Secret place',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')

let db: Database
let calendarId: number
let objects: string[]
let stamp: string
let readFails: boolean
let calendarGone: boolean
let sends: { principal: string; method: string; path: string }[]

const send: StoreSend = async (principal, method, path) => {
  sends.push({ principal, method, path })
  if (readFails) return null
  if (calendarGone) return { status: 404, text: '' }
  if (method === 'PROPFIND') {
    return {
      status: 207,
      text: `<multistatus xmlns="DAV:"><response><propstat><prop><getctag xmlns="http://calendarserver.org/ns/">${stamp}</getctag><sync-token>t-${stamp}</sync-token></prop></propstat></response></multistatus>`,
    }
  }
  const data = objects
    .map(
      (ics, i) =>
        `<response><href>/x/${i}.ics</href><propstat><prop><C:calendar-data>${ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</C:calendar-data></prop></propstat></response>`,
    )
    .join('')
  return {
    status: 207,
    text: `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${data}</multistatus>`,
  }
}

beforeEach(() => {
  db = openDatabase(':memory:')
  runMigrations(
    db,
    loadMigrationsFromDir(fileURLToPath(new URL('../../server/db/migrations', import.meta.url))),
  )
  calendarId = Number(
    db
      .prepare(
        "INSERT INTO calendars (name, kind, collection_path, color) VALUES ('Alice & Co', 'shared', ?, '#1d4ed8')",
      )
      .run(`/${ALICE}/work/`).lastInsertRowid,
  )
  addCalendarAcl(db, calendarId, { principalType: 'user', principal: BOB, permission: 'free_busy' })
  addCalendarAcl(db, calendarId, { principalType: 'group', principal: 'team', permission: 'read' })
  objects = [
    event('secret-uid-1@alice.example.org', 'Dentist', '20261105T090000Z'),
    event('secret-uid-2', 'Interview', '20261106T090000Z'),
  ]
  stamp = 'c1'
  readFails = false
  calendarGone = false
  sends = []
})

afterEach(() => db.close())

function setup() {
  const upstream = vi.fn(async () => new Response('from Radicale', { status: 207 }))
  const handle = createGateway({
    upstream: 'http://radicale:5232',
    maxBodyBytes: 100_000,
    authenticate: async (headers) => ({ sub: headers.get('x-test-user') ?? BOB }),
    precheck: createPathPrecheck(db, membership),
    busyView: createBusyView({ db, membership, send, log: () => undefined }),
    fetch: upstream as unknown as typeof fetch,
  })
  const call = (method: string, target: string, body = '', headers: Record<string, string> = {}) =>
    handle({
      method,
      target,
      headers: new Headers({ depth: '1', ...headers }),
      body: body
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body))
              controller.close()
            },
          })
        : null,
    })
  return { call, upstream }
}

const share = () => `/caldav/${BOB}/shared-${calendarId}/`
const hrefs = (xml: string) => [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]!)
const SYNC = (token: string) =>
  `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`

describe('the busy view', () => {
  it('lists the calendar and its busy copies, read as the owner at the stored path', async () => {
    const { call, upstream } = setup()
    const one = await call(
      'PROPFIND',
      share(),
      '<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/" xmlns:X="urn:x"><D:prop><D:displayname/><CS:getctag/><D:sync-token/><D:resourcetype/><X:unknown/></D:prop></D:propfind>',
      { depth: '0' },
    )
    expect(one.status).toBe(207)
    const text = await one.text()
    expect(text).toContain('<D:displayname>Alice &amp; Co</D:displayname>')
    expect(text).toContain('<C:calendar/>')
    expect(text).toMatch(
      /<D:sync-token>http:\/\/web-calendar\.invalid\/sync\/busy\/[0-9a-f]{32}<\/D:sync-token>/,
    )
    expect(text).toContain('<x:unknown xmlns:x="urn:x"/>')
    expect(text).toContain('404 Not Found')
    expect(hrefs(text)).toEqual([share()])

    const listing = await (await call('PROPFIND', share())).text()
    expect(hrefs(listing)).toHaveLength(3)
    expect(listing).not.toContain('secret-uid')
    expect(sends.every((s) => s.principal === ALICE && s.path === `/${ALICE}/work/`)).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('syncs: everything first, nothing for the current token, and starts over for an old one', async () => {
    const { call } = setup()
    const first = await (await call('REPORT', share(), SYNC(''))).text()
    const token = /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(first)![1]!
    expect(hrefs(first)).toHaveLength(2)
    const again = await (await call('REPORT', share(), SYNC(token))).text()
    expect(hrefs(again)).toHaveLength(0)
    expect(again).toContain(token)

    // A hidden detail changes: same busy time, same token.
    objects = [
      event('secret-uid-1@alice.example.org', 'Renamed dentist', '20261105T090000Z'),
      objects[1]!,
    ]
    stamp = 'c2'
    expect(await (await call('REPORT', share(), SYNC(token))).text()).toContain(token)
    // The time changes: the old token is refused, so the app starts over and nothing stays behind.
    objects = [event('secret-uid-2', 'Interview', '20261106T100000Z')]
    stamp = 'c3'
    const stale = await call('REPORT', share(), SYNC(token))
    expect(stale.status).toBe(403)
    expect(await stale.text()).toContain('<D:valid-sync-token/>')
  })

  it('answers multiget, calendar-query and GET with busy copies only', async () => {
    const { call } = setup()
    const listing = await (await call('PROPFIND', share())).text()
    const [first] = hrefs(listing).filter((href) => href.endsWith('.ics'))
    const multiget = await (
      await call(
        'REPORT',
        share(),
        `<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>${first}</D:href><D:href>${share()}gone.ics</D:href></C:calendar-multiget>`,
      )
    ).text()
    expect(multiget).toContain('SUMMARY:Busy')
    expect(multiget).toContain(`${share()}gone.ics</D:href><D:status>HTTP/1.1 404 Not Found`)
    for (const secret of ['Dentist', 'Interview', 'Secret place', 'secret-uid', 'alice.example']) {
      expect(multiget).not.toContain(secret)
    }

    const query = (component: string) =>
      call(
        'REPORT',
        share(),
        `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${component}"/></C:comp-filter></C:filter></C:calendar-query>`,
      )
    expect(hrefs(await (await query('VEVENT')).text())).toHaveLength(2)
    expect(hrefs(await (await query('VTODO')).text())).toHaveLength(0)

    const got = await call('GET', first!)
    expect(got.status).toBe(200)
    expect(got.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/)
    expect(await got.text()).toContain('SUMMARY:Busy')
    expect((await call('GET', `${share()}0123456789abcdef0123456789abcdef.ics`)).status).toBe(404)
    expect((await call('GET', `${share()}0.ics`)).status).toBe(404)
  })

  it('reads the owner once while the calendar is unchanged', async () => {
    const { call } = setup()
    await call('PROPFIND', share())
    await call('REPORT', share(), SYNC(''))
    expect(sends.filter((s) => s.method === 'REPORT')).toHaveLength(1)
    stamp = 'c9'
    await call('PROPFIND', share())
    expect(sends.filter((s) => s.method === 'REPORT')).toHaveLength(2)
  })

  it("leaves Radicale the free/busy query, OPTIONS and everything that is no share of 'f'", async () => {
    const { call, upstream } = setup()
    const freeBusy =
      '<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:time-range start="20261101T000000Z" end="20261201T000000Z"/></C:free-busy-query>'
    expect((await call('REPORT', share(), freeBusy)).status).toBe(207)
    expect(upstream).toHaveBeenCalledTimes(1)
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`http://radicale:5232/${BOB}/shared-${calendarId}/`)
    expect(new Headers(init.headers).get('x-remote-user')).toBe(BOB)
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(freeBusy)

    await call('OPTIONS', share())
    // bob's group share of the same calendar is `read`: Radicale answers it as it is
    await call('PROPFIND', `/caldav/${BOB}/shared-${calendarId}-team/`)
    // the owner's own calendar
    await call('PROPFIND', `/caldav/${ALICE}/work/`, '', { 'x-test-user': ALICE })
    expect(upstream).toHaveBeenCalledTimes(4)
    expect(sends).toHaveLength(0)
    // writes: refused before anything, as before
    expect((await call('PUT', `${share()}x.ics`, 'BEGIN:VCALENDAR')).status).toBe(403)
    // somebody who has no rule: refused by the pre-check, never read as the owner
    expect(
      (await call('PROPFIND', `/caldav/${EVE}/shared-${calendarId}/`, '', { 'x-test-user': EVE }))
        .status,
    ).toBe(403)
    expect(sends).toHaveLength(0)
  })

  it('says Bad Gateway when the owner cannot be read, and never passes the read on', async () => {
    readFails = true
    const { call, upstream } = setup()
    expect((await call('PROPFIND', share())).status).toBe(502)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('says Not Found for a calendar its owner deleted, whose row stays', async () => {
    calendarGone = true
    const { call, upstream } = setup()
    expect((await call('PROPFIND', share())).status).toBe(404)
    expect((await call('REPORT', share(), SYNC(''))).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('reads what a request asks for, nested values and other namespaces too', () => {
    expect(requestedProps('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>')).toBe('all')
    expect(
      requestedProps(
        '<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><getetag/><c:calendar-data><c:comp name="VCALENDAR"/></c:calendar-data></prop></propfind>',
      ),
    ).toEqual([
      { ns: 'DAV:', name: 'getetag' },
      { ns: 'urn:ietf:params:xml:ns:caldav', name: 'calendar-data' },
    ])
  })
})
