// @vitest-environment node
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTERNAL_CREDENTIAL_HEADER } from '../../shared/types/external'
import { API_MAX_BODY_BYTES } from '../../server/utils/api/body-limit'
import { createUserLimiter, type UserLimiter } from '../../server/utils/external/limits'
import {
  createExternalProxy,
  safeContentType,
  type ExternalProxyDeps,
  type ProxyAccount,
  type ProxyRequest,
} from '../../server/utils/external/proxy'
import { createSealer } from '../../server/utils/external/seal'
import { parseHostList } from '../../server/utils/ical-proxy/host-list'
import {
  createAddressPolicy,
  type AddressPolicy,
  type Resolver,
} from '../../server/utils/ical-proxy/ssrf'
import { RESOURCE_CSP } from '../../server/utils/security/headers'
import {
  FAKE_CALDAV_PATHS as PATHS,
  FAKE_EVENT_ICS,
  startFakeCalDav,
  type FakeCalDav,
} from '../helpers/fake-caldav'

// The proxy core against a real (fake) CalDAV server on loopback: what reaches the server, what
// comes back, and every way it can say no. The switch for tests lets the connection reach
// 127.0.0.1; the host policy itself is exercised with names and a stub resolver at the end.

const sealer = createSealer(Buffer.alloc(32, 9))
const LOGIN = { username: 'alice', password: 'pw-alice' }
const SUB = 'sub-alice'

let upstream: FakeCalDav
let victim: FakeCalDav
const accounts = new Map<number, ProxyAccount>()
const logs: string[] = []
let limiter: UserLimiter

function resetAccounts(): void {
  accounts.clear()
  accounts.set(1, { id: 1, origin: upstream.origin, authMode: 'none', username: null })
  accounts.set(2, { id: 2, origin: upstream.origin, authMode: 'basic', username: LOGIN.username })
}

beforeAll(async () => {
  upstream = await startFakeCalDav({ host: '127.0.0.1' })
  victim = await startFakeCalDav({ host: '127.0.0.2' })
})
afterAll(async () => {
  await upstream.close()
  await victim.close()
})
beforeEach(() => {
  upstream.clear()
  victim.clear()
  upstream.setLogin(undefined)
  upstream.setCrossOriginTarget(`${victim.origin}${PATHS.home}`)
  logs.length = 0
  resetAccounts()
  limiter = createUserLimiter()
})

const allowAll = createAddressPolicy({ allowPrivate: true })

function proxyWith(overrides: Partial<ExternalProxyDeps> = {}) {
  return createExternalProxy({
    policy: allowAll,
    sealer,
    findAccount: (userId, accountId) => (userId === 1 ? (accounts.get(accountId) ?? null) : null),
    limiter,
    allowInsecureLogins: true,
    log: (message) => logs.push(message),
    timeoutMs: 3000,
    ...overrides,
  })
}

function seal(
  accountId = 2,
  login = LOGIN,
  context: Partial<{ sub: string; origin: string }> = {},
) {
  return sealer.seal(login, {
    sub: context.sub ?? SUB,
    accountId,
    origin: context.origin ?? accounts.get(accountId)?.origin ?? upstream.origin,
  })
}

type RequestOverrides = Omit<Partial<ProxyRequest>, 'headers'> & {
  headers?: Record<string, string>
}

function request(overrides: RequestOverrides = {}): ProxyRequest {
  const { headers, ...rest } = overrides
  return {
    user: { id: 1, sub: SUB },
    accountId: '1',
    method: 'PROPFIND',
    target: PATHS.home,
    body: null,
    ...rest,
    headers: new Headers({ depth: '1', ...headers }),
  }
}

/** A request for the account with a login, carrying a good seal unless told otherwise. */
function loginRequest(overrides: RequestOverrides = {}) {
  upstream.setLogin(LOGIN)
  return request({
    accountId: '2',
    ...overrides,
    headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal()}`, ...overrides.headers },
  })
}

async function run(proxyRequest: ProxyRequest, deps: Partial<ExternalProxyDeps> = {}) {
  const response = await proxyWith(deps)(proxyRequest)
  return { response, text: await response.text() }
}

async function errorOf(proxyRequest: ProxyRequest, deps: Partial<ExternalProxyDeps> = {}) {
  const { response, text } = await run(proxyRequest, deps)
  return { status: response.status, error: (JSON.parse(text) as { error: string }).error, response }
}

function oneRequest(server: FakeCalDav = upstream) {
  expect(server.requests).toHaveLength(1)
  return server.requests[0]!
}

describe('reading a calendar through the proxy', () => {
  it('PROPFIND: the status, the XML body and the type come through, with X-Upstream-Status', async () => {
    const { response, text } = await run(
      request({ target: PATHS.home, headers: { 'content-type': 'application/xml' } }),
    )
    expect(response.status).toBe(207)
    expect(response.headers.get('x-upstream-status')).toBe('207')
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(text).toContain('<d:multistatus')
    expect(text).toContain(PATHS.calendar)
  })

  it('discovers like the app’s client does: root, principal, home, calendar', async () => {
    for (const [path, expected] of [
      ['/', PATHS.principal],
      [PATHS.root, PATHS.principal],
      [PATHS.principal, PATHS.home],
      [PATHS.home, PATHS.calendar],
      [PATHS.calendar, PATHS.event],
    ] as const) {
      const { response, text } = await run(request({ target: path }))
      expect([path, response.status]).toEqual([path, 207])
      expect(text).toContain(expected)
    }
  })

  it('REPORT: the request body reaches the server unchanged and the answer holds the event', async () => {
    const query =
      '<?xml version="1.0"?><c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:filter/></c:calendar-query>'
    const { response, text } = await run(
      request({
        method: 'REPORT',
        target: PATHS.calendar,
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          'content-length': String(query.length),
        },
        body: bodyOf(query),
      }),
    )
    expect(response.status).toBe(207)
    expect(text).toContain('BEGIN:VEVENT')
    expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO')
    const received = oneRequest()
    expect(received.method).toBe('REPORT')
    expect(received.body).toBe(query)
    expect(received.headers['content-length']).toBe(String(query.length))
    expect(received.headers['content-type']).toBe('application/xml; charset=utf-8')
  })

  it('GET and HEAD of an event: type, ETag and Last-Modified, and no body for HEAD', async () => {
    const get = await run(request({ method: 'GET', target: PATHS.event }))
    expect(get.response.status).toBe(200)
    expect(get.text).toBe(FAKE_EVENT_ICS)
    expect(get.response.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(get.response.headers.get('etag')).toBe('"fake-etag-1"')
    expect(get.response.headers.get('last-modified')).toBe('Thu, 01 Jan 2026 00:00:00 GMT')
    expect(get.response.headers.get('content-length')).toBe(
      String(Buffer.byteLength(FAKE_EVENT_ICS)),
    )

    const head = await run(request({ method: 'HEAD', target: PATHS.event }))
    expect(head.response.status).toBe(200)
    expect(head.text).toBe('')
    expect(head.response.headers.get('content-length')).toBe(
      String(Buffer.byteLength(FAKE_EVENT_ICS)),
    )
    expect(head.response.headers.get('x-upstream-status')).toBe('200')
  })

  it('OPTIONS: DAV and Allow come through', async () => {
    const { response } = await run(request({ method: 'OPTIONS', target: PATHS.calendar }))
    expect(response.status).toBe(200)
    expect(response.headers.get('dav')).toBe('1, 3, calendar-access')
    expect(response.headers.get('allow')).toBe('OPTIONS, GET, HEAD, PROPFIND, REPORT')
  })

  it('keeps the query and the trailing slash, and sends the path as written', async () => {
    upstream.route('/echo/', (recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(recorded.url)
    })
    const { text } = await run(request({ method: 'GET', target: '/echo/?a=1&b=%2F' }))
    expect(text).toBe('/echo/?a=1&b=%2F')
    const encoded = await run(request({ method: 'GET', target: '/dav/user%40example.org/' }))
    expect(encoded.response.status).toBe(404)
    expect(upstream.requests.at(-1)!.url).toBe('/dav/user%40example.org/')
  })

  it('passes a 404 and other errors of the server through with their status', async () => {
    for (const status of [403, 404, 405, 409, 412, 500, 503]) {
      upstream.route('/status', (_recorded, response) => {
        response.writeHead(status, { 'content-type': 'text/plain' })
        response.end(`s${status}`)
      })
      const { response, text } = await run(request({ method: 'GET', target: '/status' }))
      expect([status, response.status, text]).toEqual([status, status, `s${status}`])
      expect(response.headers.get('x-upstream-status')).toBe(String(status))
    }
  })

  it('answers 204 and 304 without a body', async () => {
    for (const status of [204, 304]) {
      upstream.route('/empty', (_recorded, response) => {
        response.writeHead(status)
        response.end()
      })
      const { response, text } = await run(request({ method: 'GET', target: '/empty' }))
      expect([response.status, text]).toEqual([status, ''])
      expect(response.headers.get('x-upstream-status')).toBe(String(status))
    }
  })

  it('carries a few MiB through', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    upstream.route('/big', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(big)
    })
    const { response, text } = await run(request({ method: 'GET', target: '/big' }))
    expect(response.status).toBe(200)
    expect(text.length).toBe(big.length)
  })
})

describe('methods', () => {
  it.each([
    'PUT',
    'DELETE',
    'POST',
    'PATCH',
    'PROPPATCH',
    'MKCOL',
    'MKCALENDAR',
    'COPY',
    'MOVE',
    'LOCK',
    'UNLOCK',
    'TRACE',
    'CONNECT',
    'SEARCH',
    'propfind',
    'Get',
    'PROPFIND ',
    '',
  ])('%j is a JSON 405 and nothing is sent', async (method) => {
    const { status, error, response } = await errorOf(request({ method }))
    expect([status, error]).toEqual([405, 'method_not_allowed'])
    expect(response.headers.get('allow')).toBe('PROPFIND, REPORT, GET, HEAD, OPTIONS')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('where a request can go: the origin is the account’s, never the request’s', () => {
  it.each([
    ['an absolute URL', 'https://evil.example/dav/'],
    ['a scheme-relative URL', '//evil.example/dav/'],
    ['a scheme-relative URL with the account’s host', '//127.0.0.2/dav/'],
    ['a backslash authority', '/\\evil.example/'],
    ['an empty target', ''],
    ['a query without a path', '?x=1'],
    ['dot segments', '/../../etc/passwd'],
    ['dot segments in the middle', '/dav/../admin/'],
    ['encoded dot segments', '/dav/%2e%2e/admin/'],
    ['an encoded slash', '/dav%2f..%2fadmin'],
    ['a double-encoded slash', '/dav%252fadmin'],
    ['a raw CRLF', '/dav/\r\nHost: evil.example'],
    ['a raw space', '/dav/ HTTP/1.1'],
    ['a NUL', '/dav/%00'],
    ['non-ASCII', '/dav/ä'],
    ['a fragment', '/dav/#x'],
    ['an empty segment', '/dav//home/'],
    ['a path over 2048 characters', `/${'a'.repeat(2100)}`],
    ['a query over 2048 characters', `/?${'q'.repeat(2100)}`],
  ])('%s is a 400 and nothing is sent', async (_name, target) => {
    const { status, error } = await errorOf(request({ method: 'GET', target }))
    expect([status, error]).toEqual([400, 'invalid_path'])
    expect(upstream.requests).toHaveLength(0)
    expect(victim.requests).toHaveLength(0)
  })

  it('a path that looks like an authority is only a path on the account’s server', async () => {
    const { response } = await run(request({ method: 'GET', target: '/@127.0.0.2:1/dav/' }))
    expect(response.status).toBe(404)
    expect(oneRequest().url).toBe('/@127.0.0.2:1/dav/')
    expect(victim.requests).toHaveLength(0)
  })

  it('a Host header (or any header) of the request does not choose the server', async () => {
    const given = request({
      method: 'GET',
      target: PATHS.event,
      headers: {
        host: victim.host,
        'x-forwarded-host': victim.host,
        'x-original-url': `${victim.origin}/`,
        forwarded: `host=${victim.host}`,
      },
    })
    // Positive control: the proxy really is handed these.
    expect(given.headers.get('host')).toBe(victim.host)
    expect(given.headers.get('x-original-url')).toBe(`${victim.origin}/`)
    const { response } = await run(given)
    expect(response.status).toBe(200)
    expect(victim.requests).toHaveLength(0)
    expect(oneRequest().headers.host).toBe(`${upstream.host}:${upstream.port}`)
  })

  it('an account id is a plain number; nothing else finds an account', async () => {
    for (const accountId of [
      '',
      '0',
      '01',
      '-1',
      '1.0',
      '1e0',
      ' 1',
      '1 ',
      '0x1',
      '1;2',
      '１',
      'abc',
      '99999999999999999999',
    ]) {
      const { status, error } = await errorOf(
        request({ accountId, method: 'GET', target: PATHS.event }),
      )
      expect([accountId, status, error]).toEqual([accountId, 404, 'account_not_found'])
    }
    expect(upstream.requests).toHaveLength(0)
  })

  it('a missing account and another user’s account look the same: 404 account_not_found', async () => {
    const own = await errorOf(request({ accountId: '77' }))
    const foreign = await errorOf(request({ user: { id: 2, sub: 'sub-bob' }, accountId: '1' }))
    expect([own.status, own.error]).toEqual([404, 'account_not_found'])
    expect([foreign.status, foreign.error]).toEqual([404, 'account_not_found'])
    expect(upstream.requests).toHaveLength(0)
  })

  it('another user cannot use my account with my seal either', async () => {
    const mine = loginRequest()
    const other = { ...mine, user: { id: 2, sub: 'sub-bob' } }
    expect((await errorOf(other)).error).toBe('account_not_found')
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('request headers: an allow-list, and nothing of the app’s own', () => {
  const hostile = {
    authorization: 'Bearer app-token-SECRET',
    cookie: 'session=SECRET',
    'x-forwarded-for': '203.0.113.9',
    'x-forwarded-host': 'app.example',
    'x-forwarded-proto': 'https',
    'x-real-ip': '203.0.113.9',
    forwarded: 'for=203.0.113.9',
    'x-remote-user': 'root',
    'x-remote-addr': '127.0.0.1',
    'x-script-name': '/admin',
    'x-http-method-override': 'DELETE',
    'x-upstream-authorization': 'Sealed not-a-seal',
    'proxy-authorization': 'Basic c2VjcmV0',
    origin: 'https://app.example',
    referer: 'https://app.example/settings?token=SECRET',
    'accept-language': 'de',
    'accept-encoding': 'gzip, br',
    'if-none-match': '"x"',
    'if-match': '"x"',
    'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT',
    prefer: 'return=minimal',
    destination: 'https://evil.example/x',
    overwrite: 'T',
    'user-agent': 'Mozilla/5.0 (Evil)',
    te: 'trailers',
    upgrade: 'websocket',
    'x-custom': 'SECRET',
    'sec-fetch-site': 'same-origin',
    'x-csrf-token': 'SECRET',
  }
  const ALLOWED = [
    'accept',
    'accept-encoding',
    'connection',
    'content-length',
    'content-type',
    'depth',
    'host',
    'user-agent',
  ]

  it('the hostile headers really are in the request the proxy is given (positive control)', () => {
    const given = request({ headers: hostile })
    for (const [name, value] of Object.entries(hostile))
      expect(given.headers.get(name), name).toBe(value)
  })

  it('an account without a login: only Accept, Content-Type, Depth and the fixed ones arrive', async () => {
    await run(
      request({
        method: 'REPORT',
        target: PATHS.calendar,
        headers: {
          ...hostile,
          accept: 'application/xml',
          'content-type': 'application/xml',
          'content-length': '2',
        },
        body: bodyOf('<>'),
      }),
    )
    const { headers } = oneRequest()
    expect(Object.keys(headers).sort()).toEqual(ALLOWED)
    expect(headers).toMatchObject({
      accept: 'application/xml',
      'content-type': 'application/xml',
      depth: '1',
      'user-agent': 'web-calendar',
      'accept-encoding': 'identity',
      connection: 'close',
      'content-length': '2',
    })
    expect(JSON.stringify(headers)).not.toContain('SECRET')
  })

  it('an account with a login: the same, plus the one Authorization header the proxy made', async () => {
    const { 'x-upstream-authorization': _ignored, ...withoutSeal } = hostile
    await run(loginRequest({ headers: withoutSeal }))
    const { headers } = oneRequest()
    expect(Object.keys(headers).sort()).toEqual([
      'accept-encoding',
      'authorization',
      'connection',
      'content-length',
      'depth',
      'host',
      'user-agent',
    ])
    expect(headers.authorization).toBe(`Basic ${Buffer.from('alice:pw-alice').toString('base64')}`)
    expect(JSON.stringify(headers)).not.toContain('SECRET')
    expect(JSON.stringify(headers)).not.toContain('Sealed')
  })

  it('an account without a login ignores X-Upstream-Authorization and sends no Authorization', async () => {
    await run(
      request({
        method: 'GET',
        target: PATHS.event,
        headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal()}` },
      }),
    )
    expect(oneRequest().headers.authorization).toBeUndefined()
  })

  it('sends the exact Basic header for a login with non-ASCII characters and a colon', async () => {
    const login = { username: 'ünï@example.org', password: 'pä:ss wörd ✓' }
    upstream.setLogin(login)
    const { response } = await run(
      request({
        accountId: '2',
        headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal(2, login)}` },
      }),
      {
        findAccount: () => ({ ...accounts.get(2)!, username: login.username }),
      },
    )
    expect(response.status).toBe(207)
    expect(oneRequest().headers.authorization).toBe(
      `Basic ${Buffer.from(`${login.username}:${login.password}`, 'utf8').toString('base64')}`,
    )
  })

  it('forwards Accept, Content-Type and Depth as given and a PROPFIND without a body with length 0', async () => {
    await run(
      request({
        target: PATHS.home,
        headers: { accept: 'text/xml, */*;q=0.1', depth: 'infinity' },
      }),
    )
    expect(oneRequest().headers).toMatchObject({
      accept: 'text/xml, */*;q=0.1',
      depth: 'infinity',
      'content-length': '0',
    })
    expect(oneRequest().headers['content-type']).toBeUndefined()
  })

  it.each([
    ['a Depth that is not 0, 1 or infinity', { depth: '2' }],
    ['a Depth with a list', { depth: '0, 1' }],
    ['an empty Depth', { depth: '' }],
    ['a non-ASCII Accept', { accept: 'tëxt/xml' }],
    ['an over-long Content-Type', { 'content-type': 'a/'.padEnd(600, 'b') }],
  ])(
    'refuses %s (it is not dropped: a PROPFIND without Depth means infinity)',
    async (_name, headers) => {
      const { status, error } = await errorOf(request({ headers }))
      expect([status, error]).toEqual([400, 'invalid_request'])
      expect(upstream.requests).toHaveLength(0)
    },
  )
})

describe('response headers: an allow-list, and the page’s own protection', () => {
  async function hostileAnswer(extra: Record<string, string | string[]> = {}) {
    upstream.route('/hostile', (_recorded, response) => {
      response.writeHead(200, {
        'content-type': 'application/xml',
        etag: '"e1"',
        dav: '1, calendar-access',
        allow: 'GET, HEAD',
        'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
        'content-length': '5',
        'set-cookie': ['session=SECRET; Path=/', 'other=SECRET'],
        'www-authenticate': 'Basic realm="SECRET"',
        location: 'https://evil.example/',
        refresh: '0; url=https://evil.example/',
        link: '<https://evil.example/>; rel=preload',
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
        'content-security-policy': "default-src *; script-src 'unsafe-inline'",
        'content-security-policy-report-only': 'default-src *',
        'x-frame-options': 'ALLOWALL',
        'strict-transport-security': 'max-age=0',
        'content-disposition': 'attachment; filename=SECRET',
        'clear-site-data': '"cache"',
        'x-powered-by': 'SECRET',
        server: 'SECRET',
        'x-secret': 'SECRET',
        'cache-control': 'public, max-age=31536000',
        'x-content-type-options': 'sniff-away',
        ...extra,
      })
      response.end('<ok/>')
    })
    return run(request({ method: 'GET', target: '/hostile' }))
  }

  it('passes Content-Type, ETag, DAV, Allow, Last-Modified and Content-Length, and nothing else of the server’s', async () => {
    const { response } = await hostileAnswer()
    const names = [...response.headers.keys()].sort()
    expect(names).toEqual(
      [
        'allow',
        'cache-control',
        'content-length',
        'content-security-policy',
        'content-type',
        'dav',
        'etag',
        'last-modified',
        'x-content-type-options',
        'x-upstream-status',
      ].sort(),
    )
    expect(response.headers.get('etag')).toBe('"e1"')
    expect(response.headers.get('dav')).toBe('1, calendar-access')
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('content-length')).toBe('5')
    expect(JSON.stringify([...response.headers])).not.toContain('SECRET')
    expect(JSON.stringify([...response.headers])).not.toContain('evil.example')
  })

  it('sets its own protection, whatever the server said: no-store, the sandbox, nosniff', async () => {
    const { response } = await hostileAnswer()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe(RESOURCE_CSP)
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it.each([
    ['text/html', 'application/octet-stream'],
    ['text/html; charset=utf-8', 'application/octet-stream'],
    ['TEXT/HTML', 'application/octet-stream'],
    ['application/xhtml+xml', 'application/octet-stream'],
    ['image/svg+xml', 'application/octet-stream'],
    ['application/javascript', 'application/octet-stream'],
    ['text/javascript', 'application/octet-stream'],
    ['application/pdf', 'application/octet-stream'],
    ['multipart/mixed; boundary=x', 'application/octet-stream'],
    ['garbage', 'application/octet-stream'],
    ['application/xml', 'application/xml'],
    ['application/xml; charset=utf-8', 'application/xml; charset=utf-8'],
    ['text/xml; charset="UTF-8"', 'text/xml; charset="UTF-8"'],
    ['Text/Calendar; charset=utf-8', 'Text/Calendar; charset=utf-8'],
    ['text/plain', 'text/plain'],
    ['application/json', 'application/json'],
  ])('a Content-Type of %j reaches the browser as %j', async (given, shown) => {
    expect(safeContentType(given)).toBe(shown)
    const { response } = await hostileAnswer({ 'content-type': given })
    expect(response.headers.get('content-type')).toBe(shown)
  })

  it('sends no Content-Type when the server sent none', async () => {
    upstream.route('/untyped', (_recorded, response) => {
      response.writeHead(200)
      response.end('x')
    })
    const { response } = await run(request({ method: 'GET', target: '/untyped' }))
    expect(response.headers.get('content-type')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('drops an over-long header value instead of passing it on', async () => {
    const { response } = await hostileAnswer({ etag: `"${'e'.repeat(3000)}"` })
    expect(response.headers.get('etag')).toBeNull()
  })
})

describe('the login of the account', () => {
  it('opens the seal and sends the login: the calendar answers', async () => {
    const { response, text } = await run(loginRequest())
    expect(response.status).toBe(207)
    expect(text).toContain('<d:multistatus')
    expect(oneRequest().headers.authorization).toBeDefined()
  })

  const credentialRequired = async (
    proxyRequest: ProxyRequest,
    deps: Partial<ExternalProxyDeps> = {},
  ) => {
    const { status, error, response } = await errorOf(proxyRequest, deps)
    expect([status, error]).toEqual([428, 'credential_required'])
    // Never a 401, which would send the browser to the app’s login; and no X-Upstream-Status.
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(upstream.requests).toHaveLength(0)
  }

  it('answers 428 without the header', async () => {
    upstream.setLogin(LOGIN)
    await credentialRequired(request({ accountId: '2' }))
  })

  it.each([
    ['an empty header', ''],
    ['another scheme', 'Basic YWxpY2U6cHctYWxpY2U='],
    ['no text', 'Sealed '],
    ['text that is not a seal', 'Sealed AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['a text with a bad character', 'Sealed abc+def'],
    ['two parts', 'Sealed a b'],
    ['an over-long text', `Sealed ${'A'.repeat(9000)}`],
    ['a truncated seal', 'Sealed TRUNCATED'],
  ])('answers 428 for %s', async (_name, given) => {
    upstream.setLogin(LOGIN)
    const value = given === 'Sealed TRUNCATED' ? `Sealed ${seal().slice(0, -8)}` : given
    await credentialRequired(
      request({ accountId: '2', headers: { [EXTERNAL_CREDENTIAL_HEADER]: value } }),
    )
  })

  it('answers 428 for a seal of another user, another account, another origin', async () => {
    upstream.setLogin(LOGIN)
    const base = { accountId: '2' }
    await credentialRequired(
      request({
        ...base,
        headers: {
          [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal(2, LOGIN, { sub: 'sub-mallory' })}`,
        },
      }),
    )
    await credentialRequired(
      request({ ...base, headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal(3, LOGIN)}` } }),
    )
    await credentialRequired(
      request({
        ...base,
        headers: {
          [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal(2, LOGIN, { origin: 'http://127.0.0.1:1' })}`,
        },
      }),
    )
  })

  it('answers 428 for a seal made before the account’s user name changed', async () => {
    upstream.setLogin(LOGIN)
    const oldSeal = seal()
    accounts.set(2, { ...accounts.get(2)!, username: 'alice-renamed' })
    await credentialRequired(
      request({ accountId: '2', headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${oldSeal}` } }),
    )
  })

  it('answers 428 for a seal made with another key (the key was rotated)', async () => {
    upstream.setLogin(LOGIN)
    const rotated = createSealer(Buffer.alloc(32, 1))
    const old = sealer.seal(LOGIN, { sub: SUB, accountId: 2, origin: upstream.origin })
    await credentialRequired(
      request({ accountId: '2', headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${old}` } }),
      { sealer: rotated },
    )
  })

  it('answers 428 when the server has no key at all', async () => {
    await credentialRequired(loginRequest(), { sealer: null })
  })

  it('answers the same for every cause (no oracle)', async () => {
    upstream.setLogin(LOGIN)
    const bodies = new Set<string>()
    for (const value of [
      undefined,
      'garbage',
      `Sealed ${seal(5)}`,
      `Sealed ${seal().slice(0, -3)}`,
    ]) {
      const headers: Record<string, string> =
        value === undefined ? {} : { [EXTERNAL_CREDENTIAL_HEADER]: value }
      const { response, text } = await run(request({ accountId: '2', headers }))
      bodies.add(`${response.status} ${text} ${[...response.headers.keys()].sort().join()}`)
    }
    expect(bodies.size).toBe(1)
  })

  it('a wrong password is the account’s 401: a 502 upstream_login_failed, never a 401', async () => {
    upstream.setLogin({ username: 'alice', password: 'another-password' })
    const { response, text } = await run(
      request({
        accountId: '2',
        headers: { [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${seal()}` },
      }),
    )
    expect(response.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ error: 'upstream_login_failed' })
    expect(response.headers.get('x-upstream-status')).toBe('401')
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(text).not.toContain('login required')
  })

  it('an account without a login that the server wants a login for gets the same 502', async () => {
    upstream.setLogin(LOGIN)
    const { response, text } = await run(request({ accountId: '1' }))
    expect([response.status, JSON.parse(text)]).toEqual([502, { error: 'upstream_login_failed' }])
    expect(response.headers.get('x-upstream-status')).toBe('401')
  })

  it('the route never answers 401, whatever the account’s server does', async () => {
    upstream.setLogin(LOGIN)
    const statuses = new Set<number>()
    for (const proxyRequest of [
      request({ accountId: '1' }),
      request({ accountId: '2' }),
      loginRequest(),
      request({ accountId: '9' }),
      request({ method: 'DELETE' }),
      request({ target: '../x' }),
    ]) {
      statuses.add((await proxyWith()(proxyRequest)).status)
    }
    expect(statuses.has(401)).toBe(false)
  })

  it('does not send a login over plain http unless the switch for tests is on', async () => {
    const { status, error } = await errorOf(loginRequest(), { allowInsecureLogins: false })
    expect([status, error]).toEqual([403, 'host_not_allowed'])
    expect(upstream.requests).toHaveLength(0)
    // …but an account without a login may use http.
    upstream.setLogin(undefined)
    const plain = await run(request({ method: 'GET', target: PATHS.event }), {
      allowInsecureLogins: false,
    })
    expect(plain.response.status).toBe(200)
  })
})

describe('redirects', () => {
  it('follows a redirect within the origin, with the same method, body and login', async () => {
    const body = '<propfind/>'
    const { response, text } = await run(
      loginRequest({
        target: PATHS.redirectSame,
        headers: { 'content-type': 'application/xml', 'content-length': String(body.length) },
        body: bodyOf(body),
      }),
    )
    expect(response.status).toBe(207)
    expect(text).toContain(PATHS.calendar)
    expect(upstream.requests.map((r) => [r.method, r.url])).toEqual([
      ['PROPFIND', PATHS.redirectSame],
      ['PROPFIND', PATHS.home],
    ])
    for (const received of upstream.requests) {
      expect(received.body).toBe(body)
      expect(received.headers['content-length']).toBe(String(body.length))
      expect(received.headers.authorization).toBe(
        `Basic ${Buffer.from('alice:pw-alice').toString('base64')}`,
      )
    }
  })

  it('follows a permanent redirect of /.well-known/caldav', async () => {
    const { response } = await run(request({ target: PATHS.wellKnown }))
    expect(response.status).toBe(207)
    expect(upstream.requests.map((r) => r.url)).toEqual([PATHS.wellKnown, PATHS.root])
  })

  it('follows three redirects and refuses the fourth', async () => {
    const ok = await run(request({ target: `${PATHS.redirectChain}2` }))
    expect(ok.response.status).toBe(207)
    expect(upstream.requests).toHaveLength(4)

    upstream.clear()
    const { status, error, response } = await errorOf(
      request({ target: `${PATHS.redirectChain}3` }),
    )
    expect([status, error]).toEqual([502, 'redirect_refused'])
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(upstream.requests).toHaveLength(4)
  })

  it('refuses a redirect loop', async () => {
    const { status, error } = await errorOf(request({ target: PATHS.redirectLoop }))
    expect([status, error]).toEqual([502, 'redirect_refused'])
    expect(upstream.requests).toHaveLength(4)
  })

  it('refuses a redirect to another origin, sends nothing there, and does not show the Location', async () => {
    const { status, error, response } = await errorOf(loginRequest({ target: PATHS.redirectCross }))
    expect([status, error]).toEqual([502, 'redirect_refused'])
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(victim.requests).toHaveLength(0)
    expect(upstream.requests).toHaveLength(1)
    expect(JSON.stringify([...response.headers])).not.toContain(victim.host)
  })

  it.each([
    ['another host', () => `http://${victim.host}:${upstream.port}/x`],
    ['another port on the same host', () => `http://${upstream.host}:${victim.port}/x`],
    [
      'another scheme on the same host and port',
      () => `https://${upstream.host}:${upstream.port}/x`,
    ],
    ['the default port of the same host', () => `http://${upstream.host}/x`],
    ['a scheme-relative URL to another host', () => `//${victim.host}:${victim.port}/x`],
    ['a backslash URL to another host', () => `\\\\${victim.host}:${victim.port}\\x`],
    [
      'user info that names another host',
      () => `http://${upstream.host}:${upstream.port}@${victim.host}:${victim.port}/x`,
    ],
    ['a javascript URL', () => 'javascript:alert(1)'],
    ['a data URL', () => 'data:text/plain,hi'],
  ])('refuses a redirect to %s', async (_name, location) => {
    upstream.route('/to', (_recorded, response) => {
      response.writeHead(302, { location: location() })
      response.end()
    })
    const { status, error } = await errorOf(loginRequest({ target: '/to' }))
    expect([status, error]).toEqual([502, 'redirect_refused'])
    expect(victim.requests).toHaveLength(0)
    expect(upstream.requests).toHaveLength(1)
  })

  it('follows a relative Location, with a query, and drops user info of an absolute one', async () => {
    upstream.route('/rel/a', (_recorded, response) => {
      response.writeHead(307, { location: '../rel/b?x=1#frag' })
      response.end()
    })
    upstream.route('/rel/b', (recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`at ${recorded.url}`)
    })
    expect((await run(request({ method: 'GET', target: '/rel/a' }))).text).toBe('at /rel/b?x=1')

    upstream.route('/rel/c', (_recorded, response) => {
      response.writeHead(301, {
        location: `http://evil:pw@${upstream.host}:${upstream.port}/rel/b`,
      })
      response.end()
    })
    upstream.clear()
    const { text } = await run(request({ method: 'GET', target: '/rel/c' }))
    expect(text).toBe('at /rel/b')
    expect(upstream.requests.at(-1)!.headers.authorization).toBeUndefined()
  })

  it('passes a 3xx without a Location through, and never shows a Location', async () => {
    upstream.route('/nowhere', (_recorded, response) => {
      response.writeHead(302)
      response.end()
    })
    const { response } = await run(request({ method: 'GET', target: '/nowhere' }))
    expect(response.status).toBe(302)
    expect(response.headers.get('x-upstream-status')).toBe('302')
    expect(response.headers.get('location')).toBeNull()
  })

  it('passes a 300 or 305 (not redirects we follow) through without a Location', async () => {
    for (const status of [300, 305]) {
      upstream.route('/multi', (_recorded, response) => {
        response.writeHead(status, { location: 'https://evil.example/' })
        response.end()
      })
      const { response } = await run(request({ method: 'GET', target: '/multi' }))
      expect(response.status).toBe(status)
      expect(response.headers.get('location')).toBeNull()
    }
  })
})

describe('the account’s answers that are not ordinary', () => {
  it('a 401 becomes a 502 with the JSON body, whatever the server sent with it', async () => {
    upstream.route('/denied', (_recorded, response) => {
      response.writeHead(401, {
        'www-authenticate': 'Basic realm="x"',
        'content-type': 'text/html',
        'set-cookie': 'a=b',
      })
      response.end('<html>SECRET</html>')
    })
    const { response, text } = await run(request({ method: 'GET', target: '/denied' }))
    expect(response.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ error: 'upstream_login_failed' })
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-upstream-status')).toBe('401')
    expect(text).not.toContain('SECRET')
  })

  it('a 407 is not passed on (a browser would try to answer it)', async () => {
    upstream.route('/proxy', (_recorded, response) => {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="x"' })
      response.end()
    })
    const { status, error, response } = await errorOf(request({ method: 'GET', target: '/proxy' }))
    expect([status, error]).toEqual([502, 'bad_response'])
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(response.headers.get('proxy-authenticate')).toBeNull()
  })

  it('a compressed answer is refused: the size cap is on what the browser would get', async () => {
    upstream.route('/gz', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
      response.end(gzipSync('<a/>'))
    })
    const { status, error } = await errorOf(request({ method: 'GET', target: '/gz' }))
    expect([status, error]).toEqual([502, 'bad_response'])
    // The request asked for identity.
    expect(oneRequest().headers['accept-encoding']).toBe('identity')
  })

  it('an explicit identity encoding is fine', async () => {
    upstream.route('/id', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'identity' })
      response.end('plain')
    })
    expect((await run(request({ method: 'GET', target: '/id' }))).text).toBe('plain')
  })

  it('the answer that arrives is the answer that was sent: a cut-off body is unreachable, not a short success', async () => {
    upstream.route('/cut', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      response.write('only a part')
      setTimeout(() => response.destroy(), 20)
    })
    const { status, error } = await errorOf(request({ method: 'GET', target: '/cut' }))
    expect([status, error]).toEqual([502, 'unreachable'])
  })
})

describe('limits', () => {
  it('refuses a response above the cap with too_large, announced or streamed, and delivers no part of it', async () => {
    const cap = 1000
    upstream.route('/announced', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(cap + 1))
    })
    upstream.route('/streamed', (_recorded, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      let sent = 0
      const timer = setInterval(() => {
        if (response.destroyed || sent > 20) return clearInterval(timer)
        sent++
        response.write('y'.repeat(300))
      }, 5)
      response.on('close', () => clearInterval(timer))
    })
    for (const target of ['/announced', '/streamed']) {
      const { status, error, response } = await errorOf(request({ method: 'GET', target }), {
        maxResponseBytes: cap,
      })
      expect([target, status, error]).toEqual([target, 502, 'too_large'])
      expect(response.headers.get('x-upstream-status')).toBeNull()
    }
  })

  it('accepts a response of exactly the cap', async () => {
    const cap = 1000
    upstream.route('/exact', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('z'.repeat(cap))
    })
    const { response, text } = await run(request({ method: 'GET', target: '/exact' }), {
      maxResponseBytes: cap,
    })
    expect([response.status, text.length]).toEqual([200, cap])
  })

  it('does not count the announced size of a HEAD answer', async () => {
    upstream.route('/headonly', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999999' })
      response.end()
    })
    const { response } = await run(request({ method: 'HEAD', target: '/headonly' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('999999999')
  })

  it('stops reading a response that is above the cap (the connection is closed)', async () => {
    let closed = false
    upstream.route('/endless', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.on('close', () => {
        closed = true
      })
      const timer = setInterval(() => response.write('e'.repeat(500)), 2)
      response.on('close', () => clearInterval(timer))
    })
    const { error } = await errorOf(request({ method: 'GET', target: '/endless' }), {
      maxResponseBytes: 2000,
    })
    expect(error).toBe('too_large')
    await vi.waitFor(() => expect(closed).toBe(true))
  })

  it('answers 502 timeout when the server does not answer in time, and frees the slot', async () => {
    upstream.route('/slow', () => {
      // never answers
    })
    const { status, error, response } = await errorOf(request({ method: 'GET', target: '/slow' }), {
      timeoutMs: 150,
    })
    expect([status, error]).toEqual([502, 'timeout'])
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(limiter.size().running).toBe(0)
  })

  it('the deadline covers the body too: a server that trickles is cut off', async () => {
    upstream.route('/trickle', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      const timer = setInterval(() => response.write('.'), 20)
      response.on('close', () => clearInterval(timer))
    })
    const { error } = await errorOf(request({ method: 'GET', target: '/trickle' }), {
      timeoutMs: 200,
    })
    expect(error).toBe('timeout')
  })

  it('the deadline covers the redirects: all hops share it', async () => {
    upstream.route('/hop1', (_recorded, response) => {
      setTimeout(() => {
        response.writeHead(302, { location: '/hop2' })
        response.end()
      }, 120)
    })
    upstream.route('/hop2', (_recorded, response) => {
      setTimeout(() => {
        response.writeHead(200)
        response.end('late')
      }, 120)
    })
    const { error } = await errorOf(request({ method: 'GET', target: '/hop1' }), { timeoutMs: 200 })
    expect(error).toBe('timeout')
  })

  it('answers 502 unreachable for a server that is not there', async () => {
    const closed = createServer()
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done))
    const port = (closed.address() as AddressInfo).port
    await new Promise((done) => closed.close(done))
    accounts.set(3, { id: 3, origin: `http://127.0.0.1:${port}`, authMode: 'none', username: null })
    const { status, error, response } = await errorOf(request({ accountId: '3' }))
    expect([status, error]).toEqual([502, 'unreachable'])
    expect(response.headers.get('x-upstream-status')).toBeNull()
  })

  it('stops the request when the client goes away', async () => {
    let closed = false
    upstream.route('/hang', (_recorded, response) => {
      response.on('close', () => {
        closed = true
      })
    })
    const gone = new AbortController()
    const pending = proxyWith()(request({ method: 'GET', target: '/hang', signal: gone.signal }))
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1))
    gone.abort()
    const response = await pending
    expect(response.status).toBe(502)
    await vi.waitFor(() => expect(closed).toBe(true))
    expect(limiter.size().running).toBe(0)
  })

  it('answers 429 with Retry-After when the user is over the rate, before anything is sent', async () => {
    limiter = createUserLimiter({ burst: 2 })
    for (let i = 0; i < 2; i++) {
      expect((await run(request({ method: 'GET', target: PATHS.event }))).response.status).toBe(200)
    }
    const { status, error, response } = await errorOf(
      request({ method: 'GET', target: PATHS.event }),
    )
    expect([status, error]).toEqual([429, 'rate_limited'])
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(upstream.requests).toHaveLength(2)
    // Another user has their own allowance (and their own, missing, accounts).
    const other = await errorOf(request({ user: { id: 2, sub: 'sub-bob' } }))
    expect(other.status).toBe(404)
  })

  it('answers 429 for a request beyond the concurrency of one user, and frees the slot at the end', async () => {
    limiter = createUserLimiter({ maxConcurrentPerUser: 2 })
    const release: (() => void)[] = []
    upstream.route('/held', (_recorded, response) => {
      release.push(() => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('done')
      })
    })
    const first = proxyWith()(request({ method: 'GET', target: '/held' }))
    const second = proxyWith()(request({ method: 'GET', target: '/held' }))
    await vi.waitFor(() => expect(release).toHaveLength(2))
    const refused = await errorOf(request({ method: 'GET', target: '/held' }))
    expect([refused.status, refused.error]).toEqual([429, 'rate_limited'])
    expect(refused.response.headers.get('retry-after')).toBe('1')
    expect(upstream.requests).toHaveLength(2)

    release.forEach((go) => go())
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(limiter.size().running).toBe(0)
    expect((await run(request({ method: 'GET', target: PATHS.event }))).response.status).toBe(200)
  })

  it('frees the slot after every kind of failure', async () => {
    limiter = createUserLimiter({ maxConcurrentPerUser: 1 })
    for (const proxyRequest of [
      request({ accountId: '77' }),
      request({ method: 'GET', target: '/nothing-here' }),
      request({ accountId: '2' }),
      request({ target: PATHS.redirectCross }),
    ]) {
      await proxyWith()(proxyRequest)
      expect(limiter.size().running).toBe(0)
    }
  })
})

describe('the request body', () => {
  const body = '<propfind xmlns="DAV:"><prop><displayname/></prop></propfind>'

  it('is forwarded with its exact length', async () => {
    await run(
      request({
        body: bodyOf(body),
        headers: { 'content-type': 'application/xml', 'content-length': String(body.length) },
      }),
    )
    expect(oneRequest().body).toBe(body)
    expect(oneRequest().headers['content-length']).toBe(String(body.length))
  })

  it('arrives whole when it comes in many chunks', async () => {
    async function* chunks() {
      for (const part of body.match(/.{1,7}/g)!) yield Buffer.from(part)
    }
    await run(request({ body: chunks(), headers: { 'content-length': String(body.length) } }))
    expect(oneRequest().body).toBe(body)
  })

  it('is refused on GET, HEAD and OPTIONS', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const { status, error } = await errorOf(
        request({
          method,
          target: PATHS.event,
          body: bodyOf('x'),
          headers: { 'content-length': '1' },
        }),
      )
      expect([method, status, error]).toEqual([method, 400, 'invalid_request'])
    }
    expect(upstream.requests).toHaveLength(0)
  })

  it('is limited like every API body: an announced length over the cap is a 413 and nothing is read', async () => {
    let read = false
    async function* never() {
      read = true
      yield Buffer.from('x')
    }
    const { status, error } = await errorOf(
      request({ body: never(), headers: { 'content-length': String(API_MAX_BODY_BYTES + 1) } }),
    )
    expect([status, error]).toEqual([413, 'request_too_large'])
    expect(read).toBe(false)
    expect(upstream.requests).toHaveLength(0)
  })

  it('is limited while it is read as well, whatever the headers claimed', async () => {
    const { status, error } = await errorOf(
      request({
        body: bodyOf('x'.repeat(200), 50),
        headers: { 'content-length': '10' },
      }),
      { maxRequestBytes: 100 },
    )
    expect([status, error]).toEqual([413, 'request_too_large'])
    expect(upstream.requests).toHaveLength(0)
  })

  it('accepts a body of exactly the cap', async () => {
    const exact = 'b'.repeat(API_MAX_BODY_BYTES)
    const { response } = await run(
      request({
        body: bodyOf(exact, 16 * 1024),
        headers: { 'content-length': String(exact.length) },
      }),
    )
    expect(response.status).toBe(207)
    expect(oneRequest().body.length).toBe(API_MAX_BODY_BYTES)
  })

  it.each([
    ['a chunked body', { 'transfer-encoding': 'chunked' }, 411, 'length_required'],
    ['a malformed length', { 'content-length': '12abc' }, 400, 'invalid_request'],
    ['a negative length', { 'content-length': '-1' }, 400, 'invalid_request'],
  ])('refuses %s', async (_name, headers, expectedStatus, expectedError) => {
    const { status, error } = await errorOf(request({ body: bodyOf('x'), headers }))
    expect([status, error]).toEqual([expectedStatus, expectedError])
    expect(upstream.requests).toHaveLength(0)
  })

  it('has its own share of the deadline: a client that never finishes sending is cut off', async () => {
    async function* stalled() {
      yield Buffer.from('<a')
      await new Promise(() => {})
    }
    const { status, error } = await errorOf(
      request({ body: stalled(), headers: { 'content-length': '100' } }),
      { timeoutMs: 150 },
    )
    expect([status, error]).toEqual([502, 'timeout'])
    expect(upstream.requests).toHaveLength(0)
    expect(limiter.size().running).toBe(0)
  })

  it('may be absent on PROPFIND and REPORT', async () => {
    expect((await run(request({ method: 'REPORT', target: PATHS.calendar }))).response.status).toBe(
      400, // the fake server wants a calendar-query body
    )
    expect(oneRequest().headers['content-length']).toBe('0')
  })
})

describe('logging', () => {
  it('records the method, the account, the host, the status and the duration, and nothing else', async () => {
    const secrets = [
      'PATH-SECRET',
      'QUERY-SECRET',
      'BODY-SECRET',
      'COOKIE-SECRET',
      'BEARER-SECRET',
      'pw-alice',
    ]
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    )
    upstream.route('/PATH-SECRET/', (_recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'a=SET-COOKIE-SECRET' })
      response.end('ANSWER-SECRET')
    })
    const body = '<a>BODY-SECRET</a>'
    upstream.setLogin(LOGIN)
    await run(
      loginRequest({
        method: 'REPORT',
        target: '/PATH-SECRET/?q=QUERY-SECRET',
        body: bodyOf(body),
        headers: {
          cookie: 'x=COOKIE-SECRET',
          authorization: 'Bearer BEARER-SECRET',
          'content-length': String(body.length),
        },
      }),
    )
    await run(request({ method: 'GET', target: '/missing/PATH-SECRET?q=QUERY-SECRET' }))
    await run(request({ method: 'DELETE', target: '/PATH-SECRET' }))
    await run(request({ accountId: '55', target: '/PATH-SECRET' }))
    await run(request({ target: '/PATH-SECRET/../x?q=QUERY-SECRET' }))
    await run(request({ target: PATHS.redirectCross }))

    expect(logs.length).toBeGreaterThanOrEqual(6)
    const all = logs.join('\n')
    for (const secret of secrets) expect(all, secret).not.toContain(secret)
    expect(all).not.toContain('ANSWER-SECRET')
    expect(all).not.toContain(seal())
    expect(all).not.toContain('Sealed')
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()

    expect(logs[0]).toMatch(
      new RegExp(`^\\[external\\] REPORT account=2 host=127\\.0\\.0\\.1 status=\\d+ \\d+ms$`),
    )
    // Refusals say why, in a fixed vocabulary, and never carry what the client sent.
    expect(
      logs.some((line) => /other account=1 status=405 \(method_not_allowed\)/.test(line)),
    ).toBe(true)
    expect(logs.some((line) => /account=55 status=404 \(account_not_found\)/.test(line))).toBe(true)
    expect(
      logs.some((line) => /status=502 \(redirect_refused: redirect to another origin\)/.test(line)),
    ).toBe(true)
  })

  it('does not log an arbitrary method name', async () => {
    await run(request({ method: 'X-EVIL-METHOD' }))
    expect(logs.join()).not.toContain('X-EVIL-METHOD')
    expect(logs.join()).toContain('other account=1')
  })
})

describe('every answer of the proxy is protected the same way', () => {
  it('own failures and proxied answers carry no-store, the sandbox and nosniff', async () => {
    const answers = [
      await run(request({ method: 'GET', target: PATHS.event })),
      await run(request({ method: 'DELETE' })),
      await run(request({ accountId: '9' })),
      await run(request({ target: '/../x' })),
      await run(request({ target: PATHS.redirectCross })),
      await run(request({ method: 'GET', target: '/missing' })),
    ]
    for (const { response } of answers) {
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toBe(RESOURCE_CSP)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('every own failure is JSON with exactly one key, `error`', async () => {
    const failures = [
      request({ method: 'DELETE' }),
      request({ accountId: '9' }),
      request({ target: '/../x' }),
      request({ headers: { depth: '9' } }),
      request({ target: PATHS.redirectCross }),
      request({ target: PATHS.redirectLoop }),
      loginRequest({ headers: { [EXTERNAL_CREDENTIAL_HEADER]: 'nope' } }),
    ]
    for (const proxyRequest of failures) {
      const { response, text } = await run(proxyRequest)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(Object.keys(JSON.parse(text))).toEqual(['error'])
    }
  })

  it('a proxied answer has X-Upstream-Status, an own failure never does (except the 401 mapping)', async () => {
    expect(
      (await run(request({ method: 'GET', target: PATHS.event }))).response.headers.get(
        'x-upstream-status',
      ),
    ).toBe('200')
    expect(
      (await run(request({ method: 'DELETE' }))).response.headers.get('x-upstream-status'),
    ).toBeNull()
    expect(
      (await run(request({ target: '/../x' }))).response.headers.get('x-upstream-status'),
    ).toBeNull()
  })
})

describe('the host policy on every request (names, a stub resolver)', () => {
  const resolve = vi.fn<Resolver>()
  const withList = (list: string, answer: () => string = () => '127.0.0.1'): AddressPolicy => {
    resolve.mockImplementation(async () => [{ address: answer(), family: 4 }])
    return createAddressPolicy({
      allowPrivate: false,
      resolve,
      allowedHosts: parseHostList(list).list,
    })
  }
  const named = (host: string, port: number) => {
    accounts.set(4, { id: 4, origin: `http://${host}:${port}`, authMode: 'none', username: null })
    return request({ accountId: '4', method: 'GET', target: PATHS.event })
  }

  it('refuses an account whose host is not on the list (any more): 403 host_not_allowed, nothing sent', async () => {
    const policy = withList('cal.example.org')
    const { status, error, response } = await errorOf(named('other.example.org', upstream.port), {
      policy,
    })
    expect([status, error]).toEqual([403, 'host_not_allowed'])
    expect(response.headers.get('x-upstream-status')).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
    expect(upstream.requests).toHaveLength(0)
  })

  it('refuses a listed name that resolves to loopback when the socket connects, and sends nothing', async () => {
    const policy = withList('rebind.example.org', () => '127.0.0.1')
    const { status, error } = await errorOf(named('rebind.example.org', upstream.port), { policy })
    expect([status, error]).toEqual([403, 'host_not_allowed'])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(upstream.requests).toHaveLength(0)
  })

  it('DNS rebinding: the name is looked up again on every request and every redirect hop', async () => {
    let answer = '10.255.255.1' // private: allowed for a listed host, and not reachable here
    const policy = withList('rebind.example.org', () => answer)
    const first = await errorOf(named('rebind.example.org', upstream.port), {
      policy,
      timeoutMs: 300,
    })
    expect(['unreachable', 'timeout']).toContain(first.error)
    answer = '127.0.0.1'
    const second = await errorOf(named('rebind.example.org', upstream.port), { policy })
    expect([second.status, second.error]).toEqual([403, 'host_not_allowed'])
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(upstream.requests).toHaveLength(0)
  })

  it('refuses an IP-literal account that is not listed, and the CalDAV store’s host', async () => {
    const policy = withList('cal.example.org')
    const literal = await errorOf(request({ accountId: '1', method: 'GET', target: PATHS.event }), {
      policy,
    })
    expect([literal.status, literal.error]).toEqual([403, 'host_not_allowed'])

    const store = createAddressPolicy({
      allowPrivate: false,
      resolve,
      allowedHosts: parseHostList('radicale').list,
      refusedHosts: ['radicale'],
    })
    const refused = await errorOf(named('radicale', 5232), { policy: store })
    expect([refused.status, refused.error]).toEqual([403, 'host_not_allowed'])
  })

  it('with no list and the SSRF rules on, a loopback account is refused', async () => {
    const strict = createAddressPolicy({ allowPrivate: false })
    const { status, error } = await errorOf(
      request({ accountId: '1', method: 'GET', target: PATHS.event }),
      {
        policy: strict,
      },
    )
    expect([status, error]).toEqual([403, 'host_not_allowed'])
    expect(upstream.requests).toHaveLength(0)
  })

  it('a redirect hop is checked again (the policy may change its mind between hops)', async () => {
    let calls = 0
    const flaky: AddressPolicy = {
      resolve: allowAll.resolve,
      // The account is an IP literal: one call before the request, then one per hop.
      isBlockedAddress: () => {
        calls++
        return calls > 2 // the first hop passes, the second does not
      },
      isBlockedHostname: () => false,
    }
    const { status, error } = await errorOf(request({ target: PATHS.redirectSame }), {
      policy: flaky,
    })
    expect([status, error]).toEqual([403, 'host_not_allowed'])
    expect(upstream.requests).toHaveLength(1)
  })
})

/** A request body from a string: one chunk, or `size` bytes at a time. */
function bodyOf(text: string, size = Number.POSITIVE_INFINITY): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(text)
  return (async function* () {
    for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size)
  })()
}

afterEach(() => {
  vi.restoreAllMocks()
})
