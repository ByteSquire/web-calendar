// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createCalDavClient } from '../app/utils/caldav/client'
import { DavError } from '../app/utils/caldav/errors'
import type { DavErrorKind } from '../app/utils/caldav/errors'

// The transport against a fake `fetch` that serves canned answers. Every request has to go through
// it: tsdav falls back to the global fetch, which would try the network and fail these tests.

const ORIGIN = 'http://dav.test'
const BASE = `${ORIGIN}/caldav`
const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const HOME = `/caldav/${SUB}/`

interface Call {
  method: string
  url: string
  path: string
  headers: Headers
  body: string
  signal: AbortSignal | null | undefined
}
type Handler = (call: Call) => Response | Promise<Response>

function fake(handler: Handler) {
  const calls: Call[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      path: new URL(url).pathname,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { fetch: fn, calls }
}

const xmlHeaders = { 'content-type': 'text/xml; charset=utf-8' }
const ms = (body: string, status = 207) =>
  new Response(`<?xml version='1.0' encoding='utf-8'?>\n${body}`, { status, headers: xmlHeaders })
const status = (code: number, headers: Record<string, string> = {}, body = '') =>
  new Response(body || null, { status: code, headers })

const DAV_NS = 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"'

const principalAnswer = (href = `/caldav/${SUB}/`) =>
  ms(
    `<multistatus ${DAV_NS}><response><href>/caldav/</href><propstat><prop><current-user-principal><href>${href}</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
  )
const homeAnswer = (href = HOME) =>
  ms(
    `<multistatus ${DAV_NS}><response><href>/caldav/${SUB}/</href><propstat><prop><C:calendar-home-set><href>${href}</href></C:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
  )

/** Serves discovery and delegates everything else. */
function server(rest: Handler): Handler {
  return (call) => {
    if (call.method === 'PROPFIND' && call.path === '/caldav/') return principalAnswer()
    if (
      call.method === 'PROPFIND' &&
      call.path === `/caldav/${SUB}/` &&
      /home-set/.test(call.body)
    ) {
      return homeAnswer()
    }
    return rest(call)
  }
}

const NO_ROUTE: Handler = (call) => {
  throw new Error(`unexpected request ${call.method} ${call.path}`)
}

function clientFor(handler: Handler, extra: { now?: () => number } = {}) {
  const f = fake(handler)
  return { ...f, client: createCalDavClient({ baseUrl: BASE, fetch: f.fetch, ...extra }) }
}

async function kindOf(promise: Promise<unknown>): Promise<DavErrorKind | 'resolved'> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    if (error instanceof DavError) return error.kind
    throw error
  }
}

describe('discovery', () => {
  it('reads the principal, then the calendar home, in the form the server gave', async () => {
    const { client, calls } = clientFor(server(NO_ROUTE))
    await expect(client.discover()).resolves.toEqual({
      principalUrl: `/caldav/${SUB}/`,
      homeUrl: HOME,
    })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PROPFIND /caldav/',
      `PROPFIND /caldav/${SUB}/`,
    ])
    expect(calls.every((c) => c.headers.get('depth') === '0')).toBe(true)
    expect(calls[0]!.body).toContain('current-user-principal')
    expect(calls[1]!.body).toContain('calendar-home-set')
  })

  it('sends the requests through the injected fetch, which adds the credentials', async () => {
    const seen: string[] = []
    const inner = fake(server(NO_ROUTE))
    const authed = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', 'Bearer t0k3n')
      seen.push(headers.get('authorization')!)
      return inner.fetch(input, { ...init, headers })
    }) as typeof fetch
    await createCalDavClient({ baseUrl: BASE, fetch: authed }).discover()
    expect(seen).toEqual(['Bearer t0k3n', 'Bearer t0k3n'])
  })

  it('keeps absolute hrefs absolute', async () => {
    const { client } = clientFor((call) => {
      if (call.path === '/caldav/') return principalAnswer(`${ORIGIN}/caldav/${SUB}/`)
      return homeAnswer(`${ORIGIN}/caldav/${SUB}/cal`)
    })
    await expect(client.discover()).resolves.toEqual({
      principalUrl: `${ORIGIN}/caldav/${SUB}/`,
      homeUrl: `${ORIGIN}/caldav/${SUB}/cal/`,
    })
  })

  it('reads answers whatever prefixes the server picked', async () => {
    const { client } = clientFor((call) => {
      if (call.path === '/caldav/') {
        return ms(
          `<ns0:multistatus xmlns:ns0="DAV:"><ns0:response><ns0:href>/caldav/</ns0:href><ns0:propstat><ns0:prop><ns0:current-user-principal><ns0:href>/dav/p/</ns0:href></ns0:current-user-principal></ns0:prop><ns0:status>HTTP/1.1 200 OK</ns0:status></ns0:propstat></ns0:response></ns0:multistatus>`,
        )
      }
      return ms(
        `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/p/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/dav/cals/</d:href></cal:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      )
    })
    await expect(client.discover()).resolves.toEqual({
      principalUrl: '/dav/p/',
      homeUrl: '/dav/cals/',
    })
  })

  it('caches the result for a few minutes and forgets it on clearDiscovery()', async () => {
    let clock = 1_000
    const { client, calls } = clientFor(server(NO_ROUTE), { now: () => clock })
    await client.discover()
    await client.discover()
    expect(calls).toHaveLength(2)
    clock += 4 * 60_000
    await client.discover()
    expect(calls).toHaveLength(2)
    clock += 2 * 60_000
    await client.discover()
    expect(calls).toHaveLength(4)
    client.clearDiscovery()
    await client.discover()
    expect(calls).toHaveLength(6)
  })

  it('does not cache a failure', async () => {
    let fail = true
    const { client, calls } = clientFor((call) => {
      if (fail) return status(503, { 'retry-after': '3' })
      return server(NO_ROUTE)(call)
    })
    expect(await kindOf(client.discover())).toBe('unavailable')
    fail = false
    await expect(client.discover()).resolves.toMatchObject({ homeUrl: HOME })
    expect(calls).toHaveLength(3)
  })

  it('shares one discovery between concurrent callers', async () => {
    const { client, calls } = clientFor(server(NO_ROUTE))
    await Promise.all([client.discover(), client.discover(), client.discover()])
    expect(calls).toHaveLength(2)
  })

  it('lets one caller give up without failing the other', async () => {
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const { client } = clientFor(async (call) => {
      await released
      return server(NO_ROUTE)(call)
    })
    const controller = new AbortController()
    const quitter = client.discover(controller.signal)
    const stayer = client.discover()
    controller.abort()
    expect(await kindOf(quitter)).toBe('aborted')
    release()
    await expect(stayer).resolves.toMatchObject({ homeUrl: HOME })
  })

  it.each([
    ['no principal in the answer', () => ms(`<multistatus ${DAV_NS}/>`)],
    [
      'a principal property the server refuses',
      () =>
        ms(
          `<multistatus ${DAV_NS}><response><href>/caldav/</href><propstat><prop><current-user-principal/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>`,
        ),
    ],
  ])('is a bad-response when there is %s', async (_name, answer) => {
    const { client } = clientFor(answer)
    expect(await kindOf(client.discover())).toBe('bad-response')
  })

  it('is unauthorized on 401 and keeps the status', async () => {
    const { client } = clientFor(() => status(401, { 'www-authenticate': 'Bearer' }))
    const error = await client.discover().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DavError)
    expect(error).toMatchObject({ kind: 'unauthorized', status: 401 })
  })

  it('does not follow a home set on another origin', async () => {
    const { client, calls } = clientFor((call) => {
      if (call.path === '/caldav/') return principalAnswer('http://evil.test/principal/')
      return homeAnswer()
    })
    expect(await kindOf(client.discover())).toBe('bad-response')
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/caldav/`])
  })
})

// What Radicale 3.9 sends for the home set (shortened), with its odd prefixes.
const HOME_LISTING = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/">
<response><href>/caldav/${SUB}/</href><propstat><prop><displayname /><ICAL:calendar-color /></prop><status>HTTP/1.1 404 Not Found</status></propstat><propstat><prop><resourcetype><principal /><collection /></resourcetype><current-user-privilege-set><privilege><read /></privilege><privilege><all /></privilege></current-user-privilege-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/caldav/${SUB}/def-calendar/</href><propstat><prop><displayname>Personal Calendar</displayname><resourcetype><C:calendar /><collection /></resourcetype><CS:getctag>"9792c9fa"</CS:getctag><C:supported-calendar-component-set><C:comp name="VEVENT" /><C:comp name="VJOURNAL" /><C:comp name="VTODO" /></C:supported-calendar-component-set><current-user-privilege-set><privilege><read /></privilege><privilege><C:read-free-busy /></privilege><privilege><all /></privilege><privilege><write /></privilege><privilege><write-properties /></privilege><privilege><write-content /></privilege></current-user-privilege-set></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><ICAL:calendar-color /></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
<response><href>/caldav/${SUB}/shared%20team/</href><propstat><prop><displayname> Team &amp; Friends &#x2713; </displayname><resourcetype><C:calendar /><collection /></resourcetype><ICAL:calendar-color>#FF5733FF</ICAL:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT" /></C:supported-calendar-component-set><current-user-privilege-set><privilege><read /></privilege></current-user-privilege-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/caldav/${SUB}/tasks/</href><propstat><prop><displayname>Tasks</displayname><resourcetype><C:calendar /><collection /></resourcetype><C:supported-calendar-component-set><C:comp name="VTODO" /></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/caldav/${SUB}/contacts/</href><propstat><prop><displayname>Contacts</displayname><resourcetype><collection /><CARD:addressbook xmlns:CARD="urn:ietf:params:xml:ns:carddav" /></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/caldav/${SUB}/0a1b2c/</href><propstat><prop><resourcetype><C:calendar /><collection /></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/caldav/${SUB}/forbidden/</href><status>HTTP/1.1 403 Forbidden</status></response>
</multistatus>`

describe('listCalendars', () => {
  it('lists the calendars that can hold events and nothing else', async () => {
    const { client, calls } = clientFor(
      server((call) => (call.path === HOME ? ms(HOME_LISTING) : NO_ROUTE(call))),
    )
    const calendars = await client.listCalendars()
    expect(calendars).toEqual([
      {
        url: `/caldav/${SUB}/def-calendar/`,
        displayName: 'Personal Calendar',
        color: null,
        ctag: '"9792c9fa"',
        components: ['VEVENT', 'VJOURNAL', 'VTODO'],
        readOnly: false,
        freeBusyOnly: false,
      },
      {
        url: `/caldav/${SUB}/shared%20team/`,
        displayName: 'Team & Friends ✓',
        color: '#ff5733',
        ctag: null,
        components: ['VEVENT'],
        readOnly: true,
        freeBusyOnly: false,
      },
      {
        // No displayname, no component set (any component), no privilege list: named by its path.
        url: `/caldav/${SUB}/0a1b2c/`,
        displayName: '0a1b2c',
        color: null,
        ctag: null,
        components: [],
        readOnly: false,
        freeBusyOnly: false,
      },
    ])
    const listing = calls.at(-1)!
    expect(listing.method).toBe('PROPFIND')
    expect(listing.headers.get('depth')).toBe('1')
    for (const wanted of [
      'd:displayname',
      'd:resourcetype',
      'ca:calendar-color',
      'cs:getctag',
      'c:supported-calendar-component-set',
      'd:current-user-privilege-set',
    ]) {
      expect(listing.body).toContain(`<${wanted}/>`)
    }
  })

  it.each([
    ['#FF5733FF', '#ff5733'],
    ['#ff5733', '#ff5733'],
    ['#F53', '#ff5533'],
    ['  #00AaFf80 ', '#00aaff'],
    ['red', null],
    ['rgb(1,2,3)', null],
    ['#ff573', null],
    ['#ff5733; background:url(//evil.test/x)', null],
    ['url(javascript:alert(1))', null],
  ])('reads the colour %j as %j', async (given, expected) => {
    const { client } = clientFor(
      server(() =>
        ms(
          `<multistatus ${DAV_NS} xmlns:ICAL="http://apple.com/ns/ical/"><response><href>/caldav/${SUB}/c/</href><propstat><prop><resourcetype><C:calendar/></resourcetype><ICAL:calendar-color>${given.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ICAL:calendar-color></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
        ),
      ),
    )
    expect((await client.listCalendars())[0]?.color).toBe(expected)
  })

  it('treats a privilege list without a write privilege as read-only, and bind or write-content as writable', async () => {
    const one = (name: string, privileges: string) =>
      `<response><href>/caldav/${SUB}/${name}/</href><propstat><prop><resourcetype><C:calendar/></resourcetype><current-user-privilege-set>${privileges}</current-user-privilege-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
    const { client } = clientFor(
      server(() =>
        ms(
          `<multistatus ${DAV_NS}>${one('ro', '<privilege><read/></privilege><privilege><C:read-free-busy/></privilege>')}${one('wc', '<privilege><read/></privilege><privilege><write-content/></privilege>')}${one('bind', '<privilege><read/></privilege><privilege><bind/></privilege>')}${one('single', '<privilege><read/></privilege>')}${one('fb', '<privilege><C:read-free-busy/></privilege>')}</multistatus>`,
        ),
      ),
    )
    const byName = Object.fromEntries(
      (await client.listCalendars()).map((c) => [c.displayName, [c.readOnly, c.freeBusyOnly]]),
    )
    expect(byName).toEqual({
      ro: [true, false],
      wc: [false, false],
      bind: [false, false],
      single: [true, false],
      // a free/busy share (Radicale's `f`): busy times only, never writable
      fb: [true, true],
    })
  })

  it('reads a calendar without a privilege list as a full one', async () => {
    const { client } = clientFor(
      server(() =>
        ms(
          `<multistatus ${DAV_NS}><response><href>/caldav/${SUB}/c/</href><propstat><prop><resourcetype><C:calendar/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
        ),
      ),
    )
    expect((await client.listCalendars())[0]).toMatchObject({
      readOnly: false,
      freeBusyOnly: false,
    })
  })

  it('is empty for an empty multistatus and fails like discovery on errors', async () => {
    const empty = clientFor(server(() => ms(`<multistatus ${DAV_NS}/>`)))
    await expect(empty.client.listCalendars()).resolves.toEqual([])
    const forbidden = clientFor(server(() => status(403)))
    expect(await kindOf(forbidden.client.listCalendars())).toBe('forbidden')
  })

  it('refuses a calendar home on another origin without sending a request there', async () => {
    const { client, calls } = clientFor((call) => {
      if (call.path === '/caldav/') return principalAnswer()
      return homeAnswer('//evil.test/home/')
    })
    expect(await kindOf(client.listCalendars())).toBe('bad-response')
    expect(calls.every((c) => new URL(c.url).origin === ORIGIN)).toBe(true)
  })
})

const ICS = (uid: string, summary = 'Meeting') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:${summary}\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
const CAL = `/caldav/${SUB}/cal/`
const RANGE = { start: new Date('2026-10-19T00:00:00Z'), end: new Date('2026-11-30T23:59:59Z') }

const queryAnswer = (items: string) => ms(`<multistatus ${DAV_NS}>${items}</multistatus>`)
const item = (name: string, etag: string, data?: string) =>
  `<response><href>${CAL}${name}</href><propstat><prop><getetag>${etag}</getetag>${data === undefined ? '' : `<C:calendar-data>${data}</C:calendar-data>`}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`

describe('fetchObjects', () => {
  it('asks for etag and data of the VEVENTs in the range in one request', async () => {
    const { client, calls } = clientFor(() =>
      queryAnswer(item('a.ics', '"e1"', ICS('a')) + item('b.ics', '"e2"', ICS('b'))),
    )
    const objects = await client.fetchObjects(CAL, RANGE)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.method).toBe('REPORT')
    expect(call!.url).toBe(`${ORIGIN}${CAL}`)
    expect(call!.headers.get('depth')).toBe('1')
    expect(call!.body).toContain('<c:calendar-query')
    expect(call!.body).toContain('<d:getetag/>')
    expect(call!.body).toContain('<c:calendar-data></c:calendar-data>')
    expect(call!.body).toContain('<c:comp-filter name="VEVENT">')
    expect(call!.body).toContain('<c:time-range start="20261019T000000Z" end="20261130T235959Z"/>')
    expect(call!.body).not.toContain('expand')
    expect(objects).toEqual([
      { url: `${CAL}a.ics`, etag: '"e1"', data: ICS('a') },
      { url: `${CAL}b.ics`, etag: '"e2"', data: ICS('b') },
    ])
  })

  it('asks the server to expand recurrences over the same range', async () => {
    const { client, calls } = clientFor(() => queryAnswer(''))
    await client.fetchObjects(CAL, RANGE, { expand: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toContain(
      '<c:calendar-data><c:expand start="20261019T000000Z" end="20261130T235959Z"/></c:calendar-data>',
    )
  })

  it('sends the range as UTC seconds, never narrower than asked', async () => {
    const { client, calls } = clientFor(() => queryAnswer(''))
    await client.fetchObjects(CAL, {
      start: new Date('2026-10-19T00:00:00.900Z'),
      end: new Date('2026-10-19T01:00:00.100Z'),
    })
    expect(calls[0]!.body).toContain('start="20261019T000000Z" end="20261019T010001Z"')
  })

  it('passes the iCalendar text through untouched', async () => {
    // Numeric character references (CR, LF, a check mark), entities and CDATA all decode; line
    // endings and trailing blanks stay.
    const raw =
      'BEGIN:VCALENDAR&#13;\nSUMMARY:Caf&#xe9; &amp; &lt;b&gt; &#10003;&#13;\nEND:VCALENDAR&#13;\n  '
    const { client } = clientFor(() =>
      queryAnswer(
        item('a.ics', '"e1"', raw) +
          item(
            'b.ics',
            '"e2"',
            '<![CDATA[BEGIN:VCALENDAR\r\nSUMMARY:<raw> & more\r\nEND:VCALENDAR\r\n]]>',
          ),
      ),
    )
    const [a, b] = await client.fetchObjects(CAL, RANGE)
    expect(a!.data).toBe('BEGIN:VCALENDAR\r\nSUMMARY:Café & <b> ✓\r\nEND:VCALENDAR\r\n  ')
    expect(b!.data).toBe('BEGIN:VCALENDAR\r\nSUMMARY:<raw> & more\r\nEND:VCALENDAR\r\n')
  })

  it('reads answers whatever prefixes the server picked', async () => {
    const { client } = clientFor(() =>
      ms(
        `<x0:multistatus xmlns:x0="DAV:" xmlns:x1="urn:ietf:params:xml:ns:caldav"><x0:response><x0:href>${CAL}a.ics</x0:href><x0:propstat><x0:prop><x0:getetag>W/"weak-1"</x0:getetag><x1:calendar-data>${ICS('a')}</x1:calendar-data></x0:prop><x0:status>HTTP/1.1 200 OK</x0:status></x0:propstat></x0:response></x0:multistatus>`,
      ),
    )
    await expect(client.fetchObjects(CAL, RANGE)).resolves.toEqual([
      { url: `${CAL}a.ics`, etag: '"weak-1"', data: ICS('a') },
    ])
  })

  it('normalizes entity tags: no weak prefix, always quoted', async () => {
    const { client } = clientFor(() =>
      queryAnswer(
        item('a.ics', 'W/&quot;w1&quot;', ICS('a')) +
          item('b.ics', 'plain', ICS('b')) +
          item('c.ics', '&quot;s1&quot;', ICS('c')),
      ),
    )
    const etags = (await client.fetchObjects(CAL, RANGE)).map((o) => o.etag)
    expect(etags).toEqual(['"w1"', '"plain"', '"s1"'])
  })

  it('fetches the data with a multiget when the query answers with etags only', async () => {
    const { client, calls } = clientFor((call) => {
      if (/calendar-multiget/.test(call.body)) {
        return queryAnswer(item('a&amp;b.ics', '"e1"', ICS('a')) + item('c.ics', '"e3"', ICS('c')))
      }
      return queryAnswer(
        item('a&amp;b.ics', '"e1"') +
          item('inline.ics', '"e2"', ICS('inline')) +
          item('c.ics', '"e3"'),
      )
    })
    const objects = await client.fetchObjects(CAL, RANGE, { expand: true })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.method).toBe('REPORT')
    expect(calls[1]!.body).toContain('<c:calendar-multiget')
    expect(calls[1]!.body).toContain(`<d:href>${CAL}a&amp;b.ics</d:href>`)
    expect(calls[1]!.body).toContain(`<d:href>${CAL}c.ics</d:href>`)
    expect(calls[1]!.body).not.toContain('inline.ics')
    expect(calls[1]!.body).toContain('<c:expand start="20261019T000000Z"')
    expect(objects.map((o) => o.url).sort()).toEqual([
      `${CAL}a&b.ics`,
      `${CAL}c.ics`,
      `${CAL}inline.ics`,
    ])
  })

  it('leaves out an object whose data the server never gives', async () => {
    const { client } = clientFor((call) =>
      /calendar-multiget/.test(call.body)
        ? queryAnswer(
            `<response><href>${CAL}b.ics</href><propstat><prop><C:calendar-data/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>`,
          )
        : queryAnswer(item('a.ics', '"e1"', ICS('a')) + item('b.ics', '"e2"')),
    )
    expect((await client.fetchObjects(CAL, RANGE)).map((o) => o.url)).toEqual([`${CAL}a.ics`])
  })

  it('skips the collection itself and answers with an error status for single objects', async () => {
    const { client } = clientFor(() =>
      queryAnswer(
        `<response><href>${CAL}</href><propstat><prop><getetag>"c"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
          `<response><href>${CAL}gone.ics</href><status>HTTP/1.1 404 Not Found</status></response>` +
          item('a.ics', '"e1"', ICS('a')),
      ),
    )
    expect((await client.fetchObjects(CAL, RANGE)).map((o) => o.url)).toEqual([`${CAL}a.ics`])
  })

  it('returns no objects for an empty multistatus', async () => {
    const { client } = clientFor(() => ms(`<multistatus xmlns="DAV:" />`))
    await expect(client.fetchObjects(CAL, RANGE)).resolves.toEqual([])
  })

  it('keeps absolute hrefs absolute', async () => {
    const { client } = clientFor(() =>
      queryAnswer(
        `<response><href>${ORIGIN}${CAL}a.ics</href><propstat><prop><getetag>"e"</getetag><C:calendar-data>${ICS('a')}</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
      ),
    )
    expect((await client.fetchObjects(`${ORIGIN}${CAL}`, RANGE))[0]!.url).toBe(
      `${ORIGIN}${CAL}a.ics`,
    )
  })

  it.each([
    ['invalid start', { start: new Date('nope'), end: RANGE.end }],
    ['invalid end', { start: RANGE.start, end: new Date(NaN) }],
    ['an empty range', { start: RANGE.start, end: RANGE.start }],
    ['an inverted range', { start: RANGE.end, end: RANGE.start }],
    ['a year beyond 9999', { start: RANGE.start, end: new Date('+010000-01-01T00:00:00Z') }],
  ])('rejects %s before any request', async (_name, range) => {
    const { client, calls } = clientFor(() => queryAnswer(''))
    await expect(client.fetchObjects(CAL, range)).rejects.toBeInstanceOf(RangeError)
    expect(calls).toHaveLength(0)
  })

  it('reports a missing calendar as not-found', async () => {
    const { client } = clientFor(() => status(404, { 'content-type': 'text/plain' }, 'nope'))
    expect(await kindOf(client.fetchObjects(CAL, RANGE))).toBe('not-found')
  })
})

describe('getObject', () => {
  it('reads the text and the ETag header', async () => {
    const { client, calls } = clientFor(() =>
      status(200, { 'content-type': 'text/calendar', etag: 'W/"g1"' }, ICS('a')),
    )
    await expect(client.getObject(`${CAL}a.ics`)).resolves.toEqual({
      url: `${CAL}a.ics`,
      etag: '"g1"',
      data: ICS('a'),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get('accept')).toBe('text/calendar')
  })

  it('looks the ETag up when the answer has no header', async () => {
    const { client, calls } = clientFor((call) =>
      call.method === 'GET'
        ? status(200, { 'content-type': 'text/calendar' }, ICS('a'))
        : queryAnswer(item('a.ics', '"looked-up"')),
    )
    expect((await client.getObject(`${CAL}a.ics`)).etag).toBe('"looked-up"')
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PROPFIND'])
    expect(calls[1]!.headers.get('depth')).toBe('0')
  })

  it('maps a missing object to not-found', async () => {
    const { client } = clientFor(() => status(404))
    expect(await kindOf(client.getObject(`${CAL}a.ics`))).toBe('not-found')
  })
})

describe('putObject', () => {
  it('updates with If-Match and returns the new ETag from the header', async () => {
    const { client, calls } = clientFor(() => status(204, { etag: 'W/"new"' }))
    await expect(
      client.putObject({ url: `${CAL}a.ics`, data: ICS('a'), etag: '"old"' }),
    ).resolves.toEqual({ url: `${CAL}a.ics`, etag: '"new"' })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.method).toBe('PUT')
    expect(call!.headers.get('if-match')).toBe('"old"')
    expect(call!.headers.get('if-none-match')).toBeNull()
    expect(call!.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(call!.body).toBe(ICS('a'))
  })

  it('quotes a bare or weak tag in If-Match', async () => {
    const { client, calls } = clientFor(() => status(204, { etag: '"n"' }))
    await client.putObject({ url: `${CAL}a.ics`, data: 'x', etag: 'W/"weak"' })
    await client.putObject({ url: `${CAL}a.ics`, data: 'x', etag: 'bare' })
    expect(calls.map((c) => c.headers.get('if-match'))).toEqual(['"weak"', '"bare"'])
  })

  it('creates with If-None-Match: *', async () => {
    const { client, calls } = clientFor(() => status(201, { etag: '"first"' }))
    await expect(
      client.putObject({ url: `${CAL}new.ics`, data: ICS('n'), create: true }),
    ).resolves.toEqual({ url: `${CAL}new.ics`, etag: '"first"' })
    expect(calls[0]!.headers.get('if-none-match')).toBe('*')
    expect(calls[0]!.headers.get('if-match')).toBeNull()
  })

  it('writes unconditionally when asked for neither', async () => {
    const { client, calls } = clientFor(() => status(201, { etag: '"x"' }))
    await client.putObject({ url: `${CAL}a.ics`, data: 'x' })
    expect(calls[0]!.headers.get('if-match')).toBeNull()
    expect(calls[0]!.headers.get('if-none-match')).toBeNull()
  })

  it('looks the new ETag up when the server leaves out the header', async () => {
    const { client, calls } = clientFor((call) =>
      call.method === 'PUT' ? status(201) : queryAnswer(item('a.ics', '"looked-up"')),
    )
    await expect(client.putObject({ url: `${CAL}a.ics`, data: 'x' })).resolves.toEqual({
      url: `${CAL}a.ics`,
      etag: '"looked-up"',
    })
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'PROPFIND'])
  })

  it('fails loudly when the saved object has no readable ETag', async () => {
    const noTag = clientFor((call) => (call.method === 'PUT' ? status(201) : queryAnswer('')))
    expect(await kindOf(noTag.client.putObject({ url: `${CAL}a.ics`, data: 'x' }))).toBe(
      'bad-response',
    )
    const lookupFails = clientFor((call) => (call.method === 'PUT' ? status(201) : status(503)))
    expect(await kindOf(lookupFails.client.putObject({ url: `${CAL}a.ics`, data: 'x' }))).toBe(
      'bad-response',
    )
  })

  it.each<[string, { etag?: string; create?: boolean }, number, DavErrorKind]>([
    ['412 on an update is a conflict', { etag: '"old"' }, 412, 'conflict'],
    ['412 on a create means it exists', { create: true }, 412, 'exists'],
    ['409', { etag: '"old"' }, 409, 'conflict'],
    ['401', { etag: '"old"' }, 401, 'unauthorized'],
    ['403', { etag: '"old"' }, 403, 'forbidden'],
    ['404', { etag: '"old"' }, 404, 'not-found'],
    ['410', { etag: '"old"' }, 410, 'not-found'],
    ['400 (bad iCalendar)', { create: true }, 400, 'rejected'],
    ['413', { create: true }, 413, 'rejected'],
    ['415', { create: true }, 415, 'rejected'],
    ['429', { create: true }, 429, 'unavailable'],
    ['500', { create: true }, 500, 'unavailable'],
    ['502 (the gateway turned a Radicale 401 into this)', { create: true }, 502, 'unavailable'],
    ['503', { create: true }, 503, 'unavailable'],
  ])('maps %s', async (_name, args, code, kind) => {
    const { client } = clientFor(() => status(code, { 'retry-after': '2' }, 'no'))
    const error = await client
      .putObject({ url: `${CAL}a.ics`, data: 'x', ...args })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DavError)
    expect(error).toMatchObject({ kind, status: code })
  })

  it('refuses contradictory or unusable conditions before any request', async () => {
    const { client, calls } = clientFor(() => status(204, { etag: '"x"' }))
    const bad = [
      { url: `${CAL}a.ics`, data: 'x', create: true, etag: '"old"' },
      { url: `${CAL}a.ics`, data: 'x', etag: '' },
      { url: `${CAL}a.ics`, data: 'x', etag: '""' },
      { url: `${CAL}a.ics`, data: 'x', etag: '"a"\r\nX-Evil: 1' },
    ]
    for (const args of bad) await expect(client.putObject(args)).rejects.toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
  })
})

describe('deleteObject', () => {
  it('deletes with If-Match', async () => {
    const { client, calls } = clientFor(() => status(204))
    await expect(client.deleteObject(`${CAL}a.ics`, '"e1"')).resolves.toBeUndefined()
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.headers.get('if-match')).toBe('"e1"')
  })

  it('deletes unconditionally without a tag', async () => {
    const { client, calls } = clientFor(() => status(200))
    await client.deleteObject(`${CAL}a.ics`)
    expect(calls[0]!.headers.get('if-match')).toBeNull()
  })

  it.each<[number, DavErrorKind]>([
    [412, 'conflict'],
    [404, 'not-found'],
    [403, 'forbidden'],
    [401, 'unauthorized'],
    [503, 'unavailable'],
  ])('maps %i to %s', async (code, kind) => {
    const { client } = clientFor(() => status(code))
    expect(await kindOf(client.deleteObject(`${CAL}a.ics`, '"e1"'))).toBe(kind)
  })
})

describe('createCalendar', () => {
  it('makes an events calendar in the home set', async () => {
    const { client, calls } = clientFor(server(() => status(201)))
    const calendar = await client.createCalendar({
      displayName: '  Work <&> "ops"  ',
      color: '#AABBCC',
      slug: 'work-1',
    })
    expect(calendar).toEqual({
      url: `${HOME}work-1/`,
      displayName: 'Work <&> "ops"',
      color: '#aabbcc',
      ctag: null,
      components: ['VEVENT'],
      readOnly: false,
      freeBusyOnly: false,
    })
    const make = calls.at(-1)!
    expect(make.method).toBe('MKCALENDAR')
    expect(make.url).toBe(`${ORIGIN}${HOME}work-1/`)
    expect(make.body).toContain('<d:displayname>Work &lt;&amp;&gt; &quot;ops&quot;</d:displayname>')
    expect(make.body).toContain('<ca:calendar-color>#aabbcc</ca:calendar-color>')
    expect(make.body).toContain(
      '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
    )
  })

  it('picks a random slug and leaves out the colour when none is given', async () => {
    const { client, calls } = clientFor(server(() => status(201)))
    const a = await client.createCalendar({ displayName: 'A' })
    const b = await client.createCalendar({ displayName: 'B' })
    expect(a.url).toMatch(new RegExp(`^${HOME}[0-9a-f-]{36}/$`))
    expect(a.url).not.toBe(b.url)
    expect(a.color).toBeNull()
    expect(calls.at(-1)!.body).not.toContain('calendar-color')
    // discovery ran once for both
    expect(calls.filter((c) => c.method === 'PROPFIND')).toHaveLength(2)
  })

  it.each<[number, DavErrorKind]>([
    [409, 'exists'],
    [405, 'exists'],
    [403, 'forbidden'],
    [401, 'unauthorized'],
    [507, 'unavailable'],
    [415, 'rejected'],
  ])('maps %i to %s', async (code, kind) => {
    const { client } = clientFor(server(() => status(code)))
    expect(await kindOf(client.createCalendar({ displayName: 'A', slug: 'a' }))).toBe(kind)
  })

  it('does not take a 207 (properties refused) for success', async () => {
    const { client } = clientFor(server(() => ms(`<multistatus ${DAV_NS}/>`)))
    expect(await kindOf(client.createCalendar({ displayName: 'A', slug: 'a' }))).toBe('rejected')
  })

  it.each([
    ['an empty name', { displayName: '   ' }],
    ['a name with a control character', { displayName: 'a\u0001b' }],
    ['a slug with a dot', { displayName: 'A', slug: 'a.b' }],
    ['a slug with a slash', { displayName: 'A', slug: 'a/b' }],
    ['a slug that climbs', { displayName: 'A', slug: '..' }],
    ['a slug with upper case', { displayName: 'A', slug: 'Work' }],
    ['an empty slug', { displayName: 'A', slug: '' }],
    ['a slug that is too long', { displayName: 'A', slug: 'a'.repeat(64) }],
    ['a slug that starts with a dash', { displayName: 'A', slug: '-a' }],
    ['a colour name', { displayName: 'A', color: 'red' }],
    ['a short colour', { displayName: 'A', color: '#fff' }],
    ['a colour that breaks out of the element', { displayName: 'A', color: '#aabbcc</x>' }],
  ])('rejects %s before any request', async (_name, args) => {
    const { client, calls } = clientFor(server(() => status(201)))
    await expect(client.createCalendar(args)).rejects.toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
  })
})

describe('failures below HTTP', () => {
  const listing = (c: ReturnType<typeof clientFor>['client']) => c.fetchObjects(CAL, RANGE)

  it('maps a rejected fetch to network', async () => {
    const { client } = clientFor(() => {
      throw new TypeError('Failed to fetch')
    })
    const error = await listing(client).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'network' })
    expect((error as DavError).cause).toBeInstanceOf(TypeError)
  })

  it('maps an AbortError to aborted', async () => {
    const { client } = clientFor(() => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    expect(await kindOf(listing(client))).toBe('aborted')
  })

  it('treats a timeout as a network problem, not as the caller giving up', async () => {
    const { client } = clientFor(() => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    })
    expect(await kindOf(listing(client))).toBe('network')
    const slow = clientFor(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal!.addEventListener('abort', () => reject(call.signal!.reason))
        }),
    )
    expect(
      await kindOf(slow.client.fetchObjects(CAL, RANGE, { signal: AbortSignal.timeout(5) })),
    ).toBe('network')
  })

  it('does not send a request when the signal has already fired', async () => {
    const { client, calls } = clientFor(() => queryAnswer(''))
    const controller = new AbortController()
    controller.abort()
    expect(await kindOf(client.fetchObjects(CAL, RANGE, { signal: controller.signal }))).toBe(
      'aborted',
    )
    expect(await kindOf(client.getObject(`${CAL}a.ics`, controller.signal))).toBe('aborted')
    expect(await kindOf(client.listCalendars(controller.signal))).toBe('aborted')
    expect(calls).toHaveLength(0)
  })

  it('cancels a request in flight and passes the signal to fetch', async () => {
    const { client, calls } = clientFor(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const controller = new AbortController()
    const pending = client.fetchObjects(CAL, RANGE, { signal: controller.signal })
    await Promise.resolve()
    expect(calls[0]!.signal).toBe(controller.signal)
    controller.abort()
    expect(await kindOf(pending)).toBe('aborted')
  })

  it('passes the signal to writes too', async () => {
    const { client, calls } = clientFor(() => status(204, { etag: '"x"' }))
    const controller = new AbortController()
    await client.putObject({ url: `${CAL}a.ics`, data: 'x', signal: controller.signal })
    await client.deleteObject(`${CAL}a.ics`, undefined, controller.signal)
    expect(calls.map((c) => c.signal)).toEqual([controller.signal, controller.signal])
  })

  it('maps an abort while the body is being read', async () => {
    const controller = new AbortController()
    const { client } = clientFor(() => {
      const body = new ReadableStream({
        pull() {
          controller.abort()
          throw new DOMException('aborted', 'AbortError')
        },
      })
      return new Response(body, { status: 200, headers: xmlHeaders })
    })
    expect(await kindOf(client.fetchObjects(CAL, RANGE, { signal: controller.signal }))).toBe(
      'aborted',
    )
  })

  it('lets a DavError from the injected fetch through (token renewal failed)', async () => {
    const { client } = clientFor(() => {
      throw new DavError('unauthorized', 'the session ended')
    })
    const error = await listing(client).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'unauthorized', message: 'the session ended' })
  })

  it.each([
    ['malformed XML', () => ms(`<multistatus xmlns="DAV:"><response><href>`)],
    ['not XML at all', () => ms('this is { not xml', 207)],
    [
      'an HTML page with status 200 (a wrong base URL)',
      () =>
        new Response('<!doctype html><title>app</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ],
    ['XML that is not a multistatus', () => ms('<error xmlns="DAV:"/>', 200)],
    ['an empty 207', () => new Response('', { status: 207, headers: xmlHeaders })],
    [
      'a multistatus with the wrong content type',
      () =>
        new Response(`<multistatus xmlns="DAV:"/>`, {
          status: 207,
          headers: { 'content-type': 'text/plain' },
        }),
    ],
  ])('is a bad-response for %s', async (_name, answer) => {
    const { client } = clientFor(answer)
    expect(await kindOf(listing(client))).toBe('bad-response')
  })

  it('maps an HTTP error with an XML body by its status', async () => {
    const { client } = clientFor(() =>
      ms(
        `<error xmlns="DAV:"><C:no-uid-conflict xmlns:C="urn:ietf:params:xml:ns:caldav"/></error>`,
        403,
      ),
    )
    expect(await kindOf(listing(client))).toBe('forbidden')
  })
})

describe('URLs outside the server', () => {
  // The injected fetch adds the user's token to whatever it is asked for, so a URL on another
  // origin (from a hostile server answer or a caller's slip) must never reach it.
  const FOREIGN = [
    ['an absolute URL on another host', 'http://evil.test/caldav/x/'],
    ['a protocol-relative URL', '//evil.test/caldav/x/'],
    ['a look-alike host', 'http://dav.test.evil.test/caldav/x/'],
    ['a look-alike with userinfo', 'http://dav.test@evil.test/caldav/x/'],
    ['another port', 'http://dav.test:8080/caldav/x/'],
    ['another scheme', 'https://dav.test/caldav/x/'],
    ['credentials in the URL', 'http://user:secret@dav.test/caldav/x/'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/calendar,BEGIN:VCALENDAR'],
    ['a file: URL', 'file:///etc/passwd'],
  ] as const

  it.each(FOREIGN)('refuses %s from the caller', async (_name, href) => {
    const { client, calls } = clientFor(() => status(204, { etag: '"x"' }))
    const results = await Promise.all([
      kindOf(client.fetchObjects(href, RANGE)),
      kindOf(client.getObject(href)),
      kindOf(client.putObject({ url: href, data: 'x', create: true })),
      kindOf(client.deleteObject(href, '"e"')),
    ])
    expect(results).toEqual(['bad-response', 'bad-response', 'bad-response', 'bad-response'])
    expect(calls).toHaveLength(0)
  })

  it.each(FOREIGN)('refuses %s as the calendar home the server names', async (_name, href) => {
    const { client, calls } = clientFor((call) =>
      call.path === '/caldav/' ? principalAnswer() : homeAnswer(href),
    )
    expect(await kindOf(client.listCalendars())).toBe('bad-response')
    expect(calls.every((c) => c.url.startsWith(`${ORIGIN}/`))).toBe(true)
  })

  it('leaves out calendars and objects the server places on another origin', async () => {
    const entry = (href: string) =>
      `<response><href>${href}</href><propstat><prop><resourcetype><C:calendar/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
    const listing = clientFor(
      server(() =>
        ms(
          `<multistatus ${DAV_NS}>${entry('http://evil.test/c/')}${entry('//evil.test/d/')}${entry(`/caldav/${SUB}/ok/`)}</multistatus>`,
        ),
      ),
    )
    expect((await listing.client.listCalendars()).map((c) => c.url)).toEqual([`/caldav/${SUB}/ok/`])

    const objects = clientFor(() =>
      queryAnswer(
        item('a.ics', '"e1"', ICS('a')).replace(CAL, 'http://evil.test/x/') +
          item('b.ics', '"e2"', ICS('b')),
      ),
    )
    expect((await objects.client.fetchObjects(CAL, RANGE)).map((o) => o.url)).toEqual([
      `${CAL}b.ics`,
    ])
    expect(objects.calls).toHaveLength(1)
  })

  it('refuses a base URL that is not an absolute http(s) URL', () => {
    expect(() => createCalDavClient({ baseUrl: 'not a url', fetch })).toThrow(TypeError)
    expect(() => createCalDavClient({ baseUrl: 'ftp://dav.test/caldav', fetch })).toThrow(TypeError)
    expect(() => createCalDavClient({ baseUrl: '/caldav', fetch })).toThrow(TypeError)
  })
})

describe('busy times', () => {
  const FREE_BUSY = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VFREEBUSY',
    'FREEBUSY;FBTYPE=BUSY:20261105T090000Z/20261105T100000Z',
    'END:VFREEBUSY',
    'END:VCALENDAR',
  ].join('\r\n')
  const RANGE = {
    start: new Date('2026-11-01T00:00:00Z'),
    end: new Date('2026-11-08T00:00:00Z'),
  }
  const CAL = `/caldav/${SUB}/shared-7/`

  it('asks with a free-busy query for the range and gives the VFREEBUSY back as it came', async () => {
    const { client, calls } = clientFor(() =>
      status(200, { 'content-type': 'text/calendar; charset=utf-8' }, FREE_BUSY),
    )
    expect(await client.fetchFreeBusy(CAL, RANGE)).toBe(FREE_BUSY)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'REPORT', path: CAL })
    expect(calls[0]!.headers.get('depth')).toBe('1')
    expect(calls[0]!.body).toContain('free-busy-query')
    expect(calls[0]!.body).toContain('start="20261101T000000Z" end="20261108T000000Z"')
    expect(calls[0]!.body).not.toContain('calendar-data')
  })

  it('fails like the other reads on a refusal, and on an answer that is no VFREEBUSY', async () => {
    expect(await kindOf(clientFor(() => status(403)).client.fetchFreeBusy(CAL, RANGE))).toBe(
      'forbidden',
    )
    const other = clientFor(() => status(200, { 'content-type': 'text/html' }, '<html></html>'))
    expect(await kindOf(other.client.fetchFreeBusy(CAL, RANGE))).toBe('bad-response')
  })
})
