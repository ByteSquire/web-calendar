import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

// A small CalDAV server for tests (a plain node:http server, no dependencies), reusable by the
// unit tests of the external-account proxy and by end-to-end checks. It speaks just enough CalDAV
// for the app's client to discover and read a calendar:
//
//   /.well-known/caldav          301 to /dav/ (unauthenticated, like real servers)
//   /, /dav/                     PROPFIND: current-user-principal
//   /dav/principals/alice/       PROPFIND: current-user-principal, calendar-home-set
//   /dav/calendars/alice/        PROPFIND: the home; Depth 1 lists the calendar
//   /dav/calendars/alice/work/   PROPFIND: one calendar; Depth 1 lists the event.
//                                REPORT calendar-query / calendar-multiget: a multistatus with the
//                                recurring event. GET: the event as an .ics.
//   /dav/calendars/alice/work/standup.ics   GET / HEAD: the event
//   any path                     OPTIONS: DAV, Allow
//
// Every answer carries `Set-Cookie`, `Server` and `X-Powered-By` headers, and a 401 a
// `WWW-Authenticate` challenge, so that tests can check what a proxy strips. Optional: a required
// HTTP Basic login (401 otherwise), redirect routes (same origin, another origin, a loop, a
// chain), your own routes, and a record of every request (method, target, headers as received,
// body) to assert what reached the server.

export const FAKE_CALDAV_PATHS = {
  wellKnown: '/.well-known/caldav',
  root: '/dav/',
  principal: '/dav/principals/alice/',
  home: '/dav/calendars/alice/',
  calendar: '/dav/calendars/alice/work/',
  event: '/dav/calendars/alice/work/standup.ics',
  /** 302 to the calendar home on the same origin. */
  redirectSame: '/redirect/same',
  /** 302 to `options.crossOriginTarget`. */
  redirectCross: '/redirect/cross',
  /** 302 to itself. */
  redirectLoop: '/redirect/loop',
  /** `/redirect/chain/<n>` redirects to `/redirect/chain/<n-1>`, and `/redirect/chain/0` to the home. */
  redirectChain: '/redirect/chain/',
} as const

/** A weekly recurring event: Mondays 08:00 UTC from 2026-01-05, ten minutes long. */
export const FAKE_EVENT_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//web-calendar//fake-caldav//EN',
  'BEGIN:VEVENT',
  'UID:fake-standup@web-calendar.test',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260105T080000Z',
  'DTEND:20260105T081000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'SUMMARY:Standup',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

export const FAKE_EVENT_ETAG = '"fake-etag-1"'

export interface RecordedRequest {
  method: string
  /** The request target exactly as received: path and query. */
  url: string
  /** As received (lower-case names). */
  headers: IncomingHttpHeaders
  body: string
}

export type FakeRoute = (request: RecordedRequest, response: ServerResponse) => void

export interface FakeCalDavOptions {
  /** The address to listen on; `127.0.0.1` by default (`127.0.0.2` makes a second origin). */
  host?: string
  /** The port; a free one by default. A fixed one gives end-to-end tests a fixed URL. */
  port?: number
  /** Require HTTP Basic with this login; anything else is a 401 with a challenge. */
  login?: { username: string; password: string }
  /** Where `/redirect/cross` leads; an absolute URL on another origin. */
  crossOriginTarget?: string
}

export interface FakeCalDav {
  host: string
  port: number
  /** `http://127.0.0.1:12345`, as `new URL(...).origin` writes it. */
  origin: string
  url(path?: string): string
  /** Every request received, oldest first (redirected and 401 ones included). */
  requests: RecordedRequest[]
  /** Forgets the recorded requests. */
  clear(): void
  /** Requires this login from now on, or none with `undefined`. */
  setLogin(login: { username: string; password: string } | undefined): void
  /** Where `/redirect/cross` leads from now on. */
  setCrossOriginTarget(url: string): void
  /** Answers requests for exactly this path (query ignored) with `handler`, before anything else. */
  route(path: string, handler: FakeRoute): void
  close(): Promise<void>
}

const NAMESPACES =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:ca="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"'

interface Resource {
  href: string
  props: string
}

const PRIVILEGES =
  '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>'

function resourceAt(path: string): Resource | undefined {
  const { root, principal, home, calendar, event } = FAKE_CALDAV_PATHS
  const user = `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>`
  switch (path) {
    case '/':
    case root:
      return { href: path, props: `<d:resourcetype><d:collection/></d:resourcetype>${user}` }
    case principal:
      return {
        href: principal,
        props:
          `<d:displayname>Alice</d:displayname>${user}` +
          '<d:resourcetype><d:collection/><d:principal/></d:resourcetype>' +
          `<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>`,
      }
    case home:
      return {
        href: home,
        props: `<d:displayname>Alice</d:displayname><d:resourcetype><d:collection/></d:resourcetype>${user}`,
      }
    case calendar:
      return {
        href: calendar,
        props:
          '<d:displayname>Work</d:displayname>' +
          '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>' +
          '<ca:calendar-color>#3b82f6</ca:calendar-color>' +
          '<cs:getctag>"fake-ctag-1"</cs:getctag>' +
          '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
          `${PRIVILEGES}${user}`,
      }
    case event:
      return {
        href: event,
        props:
          `<d:getetag>${FAKE_EVENT_ETAG}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8</d:getcontenttype>` +
          '<d:resourcetype/>',
      }
    default:
      return undefined
  }
}

function multistatus(resources: Resource[]): string {
  const responses = resources
    .map(
      ({ href, props }) =>
        `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>` +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
    )
    .join('')
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NAMESPACES}>${responses}</d:multistatus>`
}

function eventResource(): Resource {
  return {
    href: FAKE_CALDAV_PATHS.event,
    props:
      `<d:getetag>${FAKE_EVENT_ETAG}</d:getetag>` +
      `<c:calendar-data><![CDATA[${FAKE_EVENT_ICS}]]></c:calendar-data>`,
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startFakeCalDav(options: FakeCalDavOptions = {}): Promise<FakeCalDav> {
  const host = options.host ?? '127.0.0.1'
  let login = options.login
  let crossOriginTarget = options.crossOriginTarget ?? 'http://127.0.0.2:1/'
  const requests: RecordedRequest[] = []
  const routes = new Map<string, FakeRoute>()

  function send(
    response: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body?: string,
  ): void {
    response.writeHead(status, {
      // What a proxy must not pass on.
      'set-cookie': 'session=fake-caldav; Path=/; HttpOnly',
      server: 'fake-caldav',
      'x-powered-by': 'fake-caldav',
      ...headers,
    })
    response.end(body)
  }

  function redirect(response: ServerResponse, location: string, status = 302): void {
    send(response, status, { location })
  }

  function handle(recorded: RecordedRequest, response: ServerResponse): void {
    const { method } = recorded
    const target = new URL(recorded.url, 'http://fake.invalid')
    const path = target.pathname

    const custom = routes.get(path)
    if (custom) return custom(recorded, response)

    // Redirects and discovery entry points need no login, like on real servers.
    if (path === FAKE_CALDAV_PATHS.wellKnown) return redirect(response, FAKE_CALDAV_PATHS.root, 301)
    if (path === FAKE_CALDAV_PATHS.redirectSame) return redirect(response, FAKE_CALDAV_PATHS.home)
    if (path === FAKE_CALDAV_PATHS.redirectCross) return redirect(response, crossOriginTarget)
    if (path === FAKE_CALDAV_PATHS.redirectLoop) return redirect(response, path)
    if (path.startsWith(FAKE_CALDAV_PATHS.redirectChain)) {
      const left = Number(path.slice(FAKE_CALDAV_PATHS.redirectChain.length))
      return redirect(
        response,
        left > 0 ? `${FAKE_CALDAV_PATHS.redirectChain}${left - 1}` : FAKE_CALDAV_PATHS.home,
      )
    }

    if (login) {
      const expected = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`
      if (recorded.headers.authorization !== expected) {
        return send(
          response,
          401,
          { 'www-authenticate': 'Basic realm="fake-caldav"', 'content-type': 'text/plain' },
          'login required',
        )
      }
    }

    if (method === 'OPTIONS') {
      return send(response, 200, {
        dav: '1, 3, calendar-access',
        allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT',
        'content-length': '0',
      })
    }

    const xml = { 'content-type': 'application/xml; charset=utf-8' }
    if (method === 'PROPFIND') {
      const here = resourceAt(path)
      if (!here) return send(response, 404, { 'content-type': 'text/plain' }, 'not found')
      const resources = [here]
      if (recorded.headers.depth === '1') {
        if (path === FAKE_CALDAV_PATHS.home) resources.push(resourceAt(FAKE_CALDAV_PATHS.calendar)!)
        if (path === FAKE_CALDAV_PATHS.calendar)
          resources.push(resourceAt(FAKE_CALDAV_PATHS.event)!)
      }
      return send(response, 207, xml, multistatus(resources))
    }
    if (method === 'REPORT') {
      if (path !== FAKE_CALDAV_PATHS.calendar) {
        return send(response, 404, { 'content-type': 'text/plain' }, 'not found')
      }
      if (!/calendar-query|calendar-multiget/.test(recorded.body)) {
        return send(response, 400, { 'content-type': 'text/plain' }, 'unsupported report')
      }
      return send(response, 207, xml, multistatus([eventResource()]))
    }
    if (method === 'GET' || method === 'HEAD') {
      if (path !== FAKE_CALDAV_PATHS.event && path !== FAKE_CALDAV_PATHS.calendar) {
        return send(response, 404, { 'content-type': 'text/plain' }, 'not found')
      }
      return send(
        response,
        200,
        {
          'content-type': 'text/calendar; charset=utf-8',
          'content-length': String(Buffer.byteLength(FAKE_EVENT_ICS)),
          etag: FAKE_EVENT_ETAG,
          'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
        },
        method === 'HEAD' ? undefined : FAKE_EVENT_ICS,
      )
    }
    return send(
      response,
      405,
      { allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT' },
      'method not allowed',
    )
  }

  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        url: request.url ?? '/',
        headers: request.headers,
        body,
      }
      requests.push(recorded)
      handle(recorded, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://${host}:${port}`

  return {
    host,
    port,
    origin,
    url: (path = '/') => `${origin}${path}`,
    requests,
    clear: () => {
      requests.length = 0
    },
    setLogin: (next) => {
      login = next
    },
    setCrossOriginTarget: (url) => {
      crossOriginTarget = url
    },
    route: (path, handler) => {
      routes.set(path, handler)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    },
  }
}
