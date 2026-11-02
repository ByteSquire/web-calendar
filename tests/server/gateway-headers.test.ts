// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  allowedOrigin,
  applyCors,
  isPreflight,
  parseCorsOrigins,
  preflightResponse,
} from '../../server/utils/gateway/cors'
import {
  ALLOWED_METHODS,
  buildUpstreamHeaders,
  filterResponseHeaders,
  isAllowedMethod,
} from '../../server/utils/gateway/headers'

const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'

describe('isAllowedMethod', () => {
  it('allows the WebDAV and CalDAV methods and nothing else', () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(
      [
        'COPY',
        'DELETE',
        'GET',
        'HEAD',
        'MKCALENDAR',
        'MKCOL',
        'MOVE',
        'OPTIONS',
        'PROPFIND',
        'PROPPATCH',
        'PUT',
        'REPORT',
      ].sort(),
    )
    for (const method of ALLOWED_METHODS) expect(isAllowedMethod(method)).toBe(true)
  })

  it.each([
    'POST',
    'PATCH',
    'TRACE',
    'CONNECT',
    'LOCK',
    'UNLOCK',
    'SEARCH',
    'BIND',
    'ACL',
    'propfind',
    'Get',
    'GET ',
    '',
    'PROPFIND\r\nX: y',
  ])('refuses %j', (method) => {
    expect(isAllowedMethod(method)).toBe(false)
  })
})

describe('buildUpstreamHeaders', () => {
  it('never lets a client set the identity Radicale trusts', () => {
    const spoofed = new Headers({
      'x-remote-user': 'bob',
      'X-Script-Name': '/evil',
      authorization: 'Bearer stolen',
      cookie: 'session=abc',
      'x-forwarded-user': 'bob',
      'x-forwarded-for': '10.0.0.1',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'x-forwarded-server': 'evil',
      forwarded: 'for=1.2.3.4;host=evil.example',
      'x-remote-addr': '1.2.3.4',
      'x-real-ip': '1.2.3.4',
      'remote-user': 'bob',
      'x-authenticated-user': 'bob',
      'x-http-method-override': 'DELETE',
      host: 'evil.example',
      connection: 'keep-alive, x-remote-user',
      'proxy-authorization': 'Basic Zm9vOmJhcg==',
      te: 'trailers',
      upgrade: 'websocket',
      'transfer-encoding': 'chunked',
      'content-length': '999',
      'accept-encoding': 'gzip',
      origin: 'https://evil.example',
    })
    const headers = buildUpstreamHeaders(spoofed, { sub: SUB })
    expect(Object.fromEntries(headers)).toEqual({
      'accept-encoding': 'identity',
      'x-remote-user': SUB,
      'x-script-name': '/caldav',
    })
  })

  it('forwards the headers CalDAV needs, and nothing else', () => {
    const inbound = new Headers({
      depth: '1',
      'content-type': 'application/xml; charset=utf-8',
      'if-match': '"abc"',
      'if-none-match': '*',
      prefer: 'return=minimal',
      overwrite: 'T',
      'user-agent': 'Thunderbird',
      accept: 'text/xml',
      'x-custom': 'dropped',
    })
    const headers = buildUpstreamHeaders(inbound, { sub: SUB })
    expect(headers.get('depth')).toBe('1')
    expect(headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(headers.get('if-match')).toBe('"abc"')
    expect(headers.get('if-none-match')).toBe('*')
    expect(headers.get('prefer')).toBe('return=minimal')
    expect(headers.get('overwrite')).toBe('T')
    expect(headers.get('user-agent')).toBe('Thunderbird')
    expect(headers.get('accept')).toBe('text/xml')
    expect(headers.has('x-custom')).toBe(false)
  })

  it('sets the identity from the argument, whatever the client sent', () => {
    const headers = buildUpstreamHeaders(new Headers({ 'x-remote-user': 'bob' }), { sub: SUB })
    expect(headers.get('x-remote-user')).toBe(SUB)
    expect(headers.get('x-script-name')).toBe('/caldav')
  })

  it('sets the destination and length computed by the gateway, not the client’s', () => {
    const headers = buildUpstreamHeaders(
      new Headers({ destination: 'https://evil.example/x', 'content-length': '1' }),
      { sub: SUB, destination: '/caldav/alice/x.ics', contentLength: 42 },
    )
    expect(headers.get('destination')).toBe('/caldav/alice/x.ics')
    expect(headers.get('content-length')).toBe('42')
    const without = buildUpstreamHeaders(new Headers({ destination: 'https://evil.example/x' }), {
      sub: SUB,
    })
    expect(without.has('destination')).toBe(false)
  })

  it.each(['', 'a/b', 'a\\b', 'two words', 'line\nbreak', 'ü'])(
    'refuses a user id that is not a safe user name (%j)',
    (sub) => {
      expect(() => buildUpstreamHeaders(new Headers(), { sub })).toThrow(TypeError)
    },
  )
})

describe('filterResponseHeaders', () => {
  it('drops cookies, hop-by-hop headers and anything the gateway owns', () => {
    const upstream = new Headers({
      'content-type': 'text/xml; charset=utf-8',
      dav: '1, 2, 3, calendar-access',
      etag: '"abc"',
      'content-length': '10',
      location: '/caldav/alice/',
      server: 'WSGIServer CPython/3.15.1',
      'x-powered-by': 'x',
      'www-authenticate': 'Basic realm="Radicale"',
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      connection: 'close, x-internal',
      'x-internal': 'secret',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      'transfer-encoding': 'chunked',
      upgrade: 'h2c',
      'proxy-authenticate': 'Basic',
      te: 'trailers',
      trailer: 'x',
    })
    upstream.append('set-cookie', 'a=1; HttpOnly')
    upstream.append('set-cookie', 'b=2')
    const headers = filterResponseHeaders(upstream)
    expect([...headers.keys()].sort()).toEqual(
      [
        'content-length',
        'content-type',
        'dav',
        'etag',
        'location',
        'x-content-type-options',
      ].sort(),
    )
    expect(headers.getSetCookie()).toEqual([])
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('drops a content-encoding and the stale length together', () => {
    const headers = filterResponseHeaders(
      new Headers({
        'content-encoding': 'gzip',
        'content-length': '10',
        'content-type': 'text/xml',
      }),
    )
    expect(headers.has('content-encoding')).toBe(false)
    expect(headers.has('content-length')).toBe(false)
    expect(headers.get('content-type')).toBe('text/xml')
  })
})

describe('parseCorsOrigins', () => {
  it('reads exact origins, normalised and without duplicates', () => {
    expect(
      parseCorsOrigins('https://app.example.org, http://localhost:3001,https://APP.example.org/,,'),
    ).toEqual({
      origins: ['https://app.example.org', 'http://localhost:3001'],
      invalid: [],
    })
    expect(parseCorsOrigins('')).toEqual({ origins: [], invalid: [] })
  })

  it('never allows a wildcard, null or anything that is not an origin', () => {
    const result = parseCorsOrigins(
      '*, null, https://app.example.org/path, ftp://app.example.org, https://user@app.example.org, app.example.org, https://app.example.org?x=1, https://ok.example.org',
    )
    expect(result.origins).toEqual(['https://ok.example.org'])
    expect(result.invalid).toHaveLength(7)
  })
})

describe('CORS responses', () => {
  const allowed = ['https://app.example.org']

  it('reflects only an exactly matching origin', () => {
    expect(allowedOrigin('https://app.example.org', allowed)).toBe('https://app.example.org')
    expect(allowedOrigin('https://app.example.org.evil.example', allowed)).toBeNull()
    expect(allowedOrigin('http://app.example.org', allowed)).toBeNull()
    expect(allowedOrigin('https://APP.example.org', allowed)).toBeNull()
    expect(allowedOrigin('null', allowed)).toBeNull()
    expect(allowedOrigin(null, allowed)).toBeNull()
    expect(allowedOrigin('https://app.example.org', [])).toBeNull()
  })

  it('recognises a preflight by method and both headers', () => {
    const headers = new Headers({
      origin: 'https://x',
      'access-control-request-method': 'PROPFIND',
    })
    expect(isPreflight('OPTIONS', headers)).toBe(true)
    expect(isPreflight('PROPFIND', headers)).toBe(false)
    expect(isPreflight('OPTIONS', new Headers({ origin: 'https://x' }))).toBe(false)
    expect(isPreflight('OPTIONS', new Headers())).toBe(false)
  })

  it('answers a preflight with the methods and headers the gateway takes', () => {
    const response = preflightResponse()
    applyCors(response.headers, 'https://app.example.org')
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.org')
    expect(response.headers.get('access-control-allow-methods')).toBe(ALLOWED_METHODS.join(', '))
    const allowHeaders = response.headers.get('access-control-allow-headers')!.split(', ')
    expect(allowHeaders).toEqual(
      expect.arrayContaining(['authorization', 'depth', 'destination', 'content-type']),
    )
    expect(response.headers.get('vary')).toBe('Origin')
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
  })

  it('exposes what a CalDAV client reads from a response', () => {
    const headers = new Headers()
    applyCors(headers, 'https://app.example.org')
    const exposed = headers.get('access-control-expose-headers')!.toLowerCase()
    for (const name of ['dav', 'etag', 'location', 'www-authenticate'])
      expect(exposed).toContain(name)
  })

  it('marks responses to other origins as varying, without allowing them', () => {
    const headers = new Headers()
    applyCors(headers, null)
    expect(headers.get('vary')).toBe('Origin')
    expect(headers.has('access-control-allow-origin')).toBe(false)
  })
})
