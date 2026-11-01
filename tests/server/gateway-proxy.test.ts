// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { authenticateRequest } from '../../server/utils/auth/authenticate'
import { AuthError } from '../../server/utils/auth/errors'
import { createBasicThrottle } from '../../server/utils/auth/throttle'
import { challengeLines } from '../../server/utils/gateway/challenges'
import {
  createGateway,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type GatewayOptions,
  type GatewayRequest,
} from '../../server/utils/gateway/gateway'

const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const MAX = 1000

interface Seen {
  url: string
  method: string
  headers: Headers
  body: Uint8Array
  init: RequestInit
}

function stream(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

async function drain(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array()
  if (body instanceof Uint8Array) return body
  return new Uint8Array(await new Response(body as ReadableStream).arrayBuffer())
}

function setup(
  respond: (seen: Seen) => Response | Promise<Response> = () => new Response('ok'),
  options: Partial<GatewayOptions> = {},
) {
  const seen: Seen[] = []
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: await drain(init?.body),
      init: init ?? {},
    }
    seen.push(entry)
    return respond(entry)
  })
  const authenticate = vi.fn(async (headers: Headers) => {
    if (headers.get('authorization') === 'Bearer other') return { sub: 'sub-someone-else' }
    if (headers.get('authorization') !== 'Bearer good') {
      throw new AuthError('no-credentials', {
        challenges: ['Basic realm="Web Calendar"', 'Bearer realm="Web Calendar"'],
      })
    }
    return { sub: SUB }
  })
  const log = vi.fn()
  const handle = createGateway({
    upstream: 'http://radicale:5232',
    maxBodyBytes: MAX,
    authenticate,
    fetch: fetchStub as unknown as typeof fetch,
    log,
    ...options,
  })
  const call = (
    method: string,
    target: string,
    init: {
      headers?: Record<string, string>
      body?: GatewayRequest['body']
      authorized?: boolean
      signal?: AbortSignal
    } = {},
  ) =>
    handle({
      method,
      target,
      headers: new Headers({
        ...(init.authorized === false ? {} : { authorization: 'Bearer good' }),
        ...init.headers,
      }),
      body: init.body ?? null,
      signal: init.signal,
    })
  return { call, seen, fetchStub, authenticate, log }
}

describe('gateway: authentication', () => {
  it('answers 401 with both challenges and never reaches Radicale', async () => {
    const { call, fetchStub } = setup()
    const response = await call('PROPFIND', '/caldav/', { authorized: false })
    expect(response.status).toBe(401)
    const challenge = response.headers.get('www-authenticate')!
    expect(challenge).toContain('Basic realm="Web Calendar"')
    expect(challenge).toContain('Bearer realm="Web Calendar"')
    // A web `Headers` joins them; the glue sends them as two lines (see gateway-challenges.test.ts).
    expect(challengeLines(response)).toEqual([
      'Basic realm="Web Calendar"',
      'Bearer realm="Web Calendar"',
    ])
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('answers 503 with Retry-After when the signing keys cannot be fetched', async () => {
    const { call, fetchStub } = setup(undefined, {
      authenticate: async () => {
        throw new AuthError('keys-unavailable')
      },
    })
    const response = await call('GET', '/caldav/')
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(response.headers.has('www-authenticate')).toBe(false)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('answers 500, not 401 or a pass-through, when authentication breaks', async () => {
    const { call, fetchStub, log } = setup(undefined, {
      authenticate: async () => {
        throw new Error('database is locked')
      },
    })
    expect((await call('GET', '/caldav/')).status).toBe(500)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })

  it('logs the reason of a failure and nothing from the request, but not a missing credential', async () => {
    const rejected = setup(undefined, {
      authenticate: async () => {
        throw new AuthError('expired')
      },
    })
    await rejected.call('GET', '/caldav/', { headers: { authorization: 'Bearer secret-token' } })
    expect(rejected.log).toHaveBeenCalledTimes(1)
    expect(rejected.log.mock.calls.flat().join(' ')).toContain('expired')
    expect(rejected.log.mock.calls.flat().join(' ')).not.toContain('secret-token')

    const anonymous = setup()
    await anonymous.call('GET', '/caldav/', { authorized: false })
    expect(anonymous.log).not.toHaveBeenCalled()
  })
})

describe('gateway: header hygiene', () => {
  it('sends the authenticated identity whatever the client claims', async () => {
    const { call, seen } = setup()
    await call('PROPFIND', '/caldav/alice/', {
      headers: {
        'x-remote-user': 'bob',
        'x-script-name': '/evil',
        'x-forwarded-user': 'bob',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-host': 'evil.example',
        forwarded: 'for=1.2.3.4',
        'x-remote-addr': '1.2.3.4',
        cookie: 'session=abc',
        depth: '0',
      },
    })
    expect(seen).toHaveLength(1)
    expect(Object.fromEntries(seen[0]!.headers)).toEqual({
      'accept-encoding': 'identity',
      depth: '0',
      'x-remote-user': SUB,
      'x-script-name': '/caldav',
    })
    // The user's own token is not passed on either.
    expect(seen[0]!.headers.has('authorization')).toBe(false)
  })

  it('does not follow redirects and does not send a signal-less request into the void', async () => {
    const { call, seen } = setup()
    await call('GET', '/caldav/')
    expect(seen[0]!.init.redirect).toBe('manual')
  })
})

describe('gateway: methods and paths', () => {
  it.each(['POST', 'PATCH', 'TRACE', 'CONNECT', 'LOCK', 'propfind'])(
    'answers 405 to %s, with the allowed methods, before anything else',
    async (method) => {
      const { call, fetchStub, authenticate } = setup()
      const response = await call(method, '/caldav/alice/')
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toContain('PROPFIND')
      expect(authenticate).not.toHaveBeenCalled()
      expect(fetchStub).not.toHaveBeenCalled()
    },
  )

  it.each([
    'OPTIONS',
    'GET',
    'HEAD',
    'PUT',
    'DELETE',
    'PROPFIND',
    'PROPPATCH',
    'REPORT',
    'MKCOL',
    'MKCALENDAR',
  ])('forwards %s under /caldav/', async (method) => {
    const { call, seen } = setup()
    const response = await call(method, '/caldav/alice/def-calendar/')
    expect(response.status).toBe(200)
    expect(seen[0]!.method).toBe(method)
    expect(seen[0]!.url).toBe('http://radicale:5232/alice/def-calendar/')
  })

  it.each([
    ['/caldav/../admin', 400],
    ['/caldav/alice/%2e%2e/bob/', 400],
    ['/caldav//alice/', 400],
    ['/caldav/a%2Fb', 400],
    ['http://evil.example/caldav/alice/', 400],
    ['//evil.example/x', 400],
    ['/other/alice/', 404],
    ['/caldav/.sharing/v1/map/create', 404],
  ])('refuses %j with %i and never reaches Radicale', async (target, status) => {
    const { call, fetchStub } = setup()
    expect((await call('PROPFIND', target)).status).toBe(status)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('checks authentication before it looks at the path', async () => {
    const { call } = setup()
    expect((await call('GET', '/caldav/../x', { authorized: false })).status).toBe(401)
  })

  it('sends only the normalised path upstream and drops the query', async () => {
    const { call, seen } = setup()
    await call('GET', '/caldav/alice/a%20b/%C3%A4.ics?evil=1')
    expect(seen[0]!.url).toBe('http://radicale:5232/alice/a%20b/%C3%A4.ics')
  })

  it('builds the URL from the configured upstream only', async () => {
    const { call, seen } = setup(undefined, { upstream: 'http://radicale:5232/' })
    await call('GET', '/caldav')
    expect(seen[0]!.url).toBe('http://radicale:5232/')
  })
})

describe('gateway: COPY and MOVE', () => {
  it('rewrites an absolute Destination to a path under /caldav/', async () => {
    const { call, seen } = setup()
    await call('MOVE', '/caldav/alice/a/e1.ics', {
      headers: {
        destination: 'https://calendar.example.org/caldav/alice/b/e1%20x.ics',
        overwrite: 'F',
      },
    })
    expect(seen[0]!.headers.get('destination')).toBe('/caldav/alice/b/e1%20x.ics')
    expect(seen[0]!.headers.get('overwrite')).toBe('F')
    expect(seen[0]!.url).toBe('http://radicale:5232/alice/a/e1.ics')
  })

  it('refuses a Destination outside /caldav/ with 403', async () => {
    const { call, fetchStub } = setup()
    for (const destination of [
      '/api/config',
      'https://calendar.example.org/',
      '/caldav/.sharing/x',
    ]) {
      const response = await call('COPY', '/caldav/alice/a/e1.ics', { headers: { destination } })
      expect(response.status).toBe(403)
    }
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('refuses a malformed or missing Destination with 400', async () => {
    const { call, fetchStub } = setup()
    for (const destination of ['/caldav/../x', 'https://u@h/caldav/x', '/caldav/x?y=1']) {
      expect(
        (await call('MOVE', '/caldav/alice/a/e1.ics', { headers: { destination } })).status,
      ).toBe(400)
    }
    expect((await call('MOVE', '/caldav/alice/a/e1.ics')).status).toBe(400)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('ignores a Destination on other methods', async () => {
    const { call, seen } = setup()
    await call('GET', '/caldav/alice/', { headers: { destination: 'https://evil.example/x' } })
    expect(seen[0]!.headers.has('destination')).toBe(false)
  })
})

describe('gateway: request bodies', () => {
  const REPORT_XML =
    '<?xml version="1.0"?><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"/>'

  it('sends the body of PROPFIND and REPORT with its Content-Length', async () => {
    const { call, seen } = setup()
    const length = String(new TextEncoder().encode(REPORT_XML).length)
    await call('REPORT', '/caldav/alice/def-calendar/', {
      headers: { 'content-type': 'application/xml', 'content-length': length },
      body: stream(REPORT_XML.slice(0, 20), REPORT_XML.slice(20)),
    })
    expect(new TextDecoder().decode(seen[0]!.body)).toBe(REPORT_XML)
    expect(seen[0]!.headers.get('content-length')).toBe(length)
    expect(seen[0]!.headers.get('content-type')).toBe('application/xml')
    expect(seen[0]!.init.body).toBeInstanceOf(ReadableStream)
    expect((seen[0]!.init as { duplex?: string }).duplex).toBe('half')
  })

  it('reads a body of unknown length itself and sends its length, because Radicale ignores chunked bodies', async () => {
    const { call, seen } = setup()
    await call('PUT', '/caldav/alice/def-calendar/e1.ics', {
      headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/calendar' },
      body: stream('BEGIN:VCALENDAR\r\n', 'END:VCALENDAR\r\n'),
    })
    expect(new TextDecoder().decode(seen[0]!.body)).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    expect(seen[0]!.headers.get('content-length')).toBe('32')
    expect(seen[0]!.headers.has('transfer-encoding')).toBe(false)
  })

  it('answers 413 for a declared length over the limit without reading the body', async () => {
    const { call, fetchStub } = setup()
    const body = stream('x')
    const response = await call('PUT', '/caldav/alice/c/e.ics', {
      headers: { 'content-length': String(MAX + 1) },
      body,
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('answers 413 for a chunked body over the limit', async () => {
    const { call, fetchStub } = setup()
    const response = await call('PUT', '/caldav/alice/c/e.ics', {
      headers: { 'transfer-encoding': 'chunked' },
      body: stream('x'.repeat(600), 'x'.repeat(600)),
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('answers 413 when a body is longer than it declared and was streamed upstream', async () => {
    const { call } = setup(async (seen) => {
      // The fake reads the stream the way fetch would.
      await drain(seen.init.body)
      return new Response('ok')
    })
    const response = await call('PUT', '/caldav/alice/c/e.ics', {
      headers: { 'content-length': '10' },
      body: stream('x'.repeat(600), 'x'.repeat(600)),
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
  })

  it('accepts a body of exactly the limit', async () => {
    const { call, seen } = setup()
    const response = await call('PUT', '/caldav/alice/c/e.ics', {
      headers: { 'content-length': String(MAX) },
      body: stream('x'.repeat(MAX)),
    })
    expect(response.status).toBe(200)
    expect(seen[0]!.body.byteLength).toBe(MAX)
  })

  it.each(['abc', '-1', '1.5', '1e3', '0x10', '', '99999999999999999999'])(
    'refuses the Content-Length %j',
    async (value) => {
      const { call, fetchStub } = setup()
      const response = await call('PUT', '/caldav/alice/c/e.ics', {
        headers: { 'content-length': value },
        body: stream('x'),
      })
      expect([400, 413]).toContain(response.status)
      expect(fetchStub).not.toHaveBeenCalled()
    },
  )

  it('sends no body for GET and HEAD, even if the client sent one', async () => {
    const { call, seen } = setup()
    await call('GET', '/caldav/alice/', { headers: { 'content-length': '3' }, body: stream('abc') })
    await call('HEAD', '/caldav/alice/', {
      headers: { 'content-length': '3' },
      body: stream('abc'),
    })
    for (const entry of seen) {
      expect(entry.body.byteLength).toBe(0)
      expect(entry.headers.has('content-length')).toBe(false)
    }
  })
})

describe('gateway: responses', () => {
  it('passes status, body and the useful headers through', async () => {
    const { call } = setup(
      () =>
        new Response('<multistatus/>', {
          status: 207,
          statusText: 'Multi-Status',
          headers: {
            'content-type': 'text/xml; charset=utf-8',
            dav: '1, 2, calendar-access',
            etag: '"x"',
          },
        }),
    )
    const response = await call('PROPFIND', '/caldav/alice/')
    expect(response.status).toBe(207)
    expect(await response.text()).toBe('<multistatus/>')
    expect(response.headers.get('dav')).toBe('1, 2, calendar-access')
    expect(response.headers.get('etag')).toBe('"x"')
    expect(response.headers.get('content-type')).toBe('text/xml; charset=utf-8')
  })

  it('drops cookies, hop-by-hop headers and the server banner from Radicale’s answer', async () => {
    const { call } = setup(() => {
      const headers = new Headers({
        server: 'WSGIServer CPython/3.15.1',
        connection: 'close',
        'keep-alive': 'timeout=5',
        'access-control-allow-origin': '*',
      })
      headers.append('set-cookie', 'a=1')
      return new Response('x', { headers })
    })
    const response = await call('GET', '/caldav/alice/')
    expect(response.headers.getSetCookie()).toEqual([])
    for (const name of ['server', 'connection', 'keep-alive', 'access-control-allow-origin']) {
      expect(response.headers.has(name)).toBe(false)
    }
  })

  it('passes a redirect from Radicale on as it is', async () => {
    const { call } = setup(
      () => new Response(null, { status: 301, headers: { location: '/caldav/' } }),
    )
    const response = await call('GET', '/caldav')
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/caldav/')
  })

  it('sends no body for HEAD and for 204 and 304', async () => {
    const { call } = setup((seen) =>
      seen.method === 'HEAD'
        ? new Response(null, {
            headers: { 'content-length': '1234', 'content-type': 'text/calendar' },
          })
        : new Response(null, { status: 204 }),
    )
    const head = await call('HEAD', '/caldav/alice/c/e.ics')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('1234')
    expect(await head.text()).toBe('')
    expect((await call('DELETE', '/caldav/alice/c/e.ics')).status).toBe(204)
  })

  it('turns a 401 from Radicale into a 502: it is the gateway’s fault, not the client’s', async () => {
    const { call, log } = setup(
      () =>
        new Response('no', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="Radicale"' },
        }),
    )
    const response = await call('GET', '/caldav/alice/')
    expect(response.status).toBe(502)
    expect(response.headers.has('www-authenticate')).toBe(false)
    expect(log).toHaveBeenCalled()
  })

  it('answers 502 when Radicale cannot be reached', async () => {
    const { call, log } = setup(() => {
      throw new TypeError('fetch failed')
    })
    const response = await call('GET', '/caldav/alice/')
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('fetch failed')
    expect(log).toHaveBeenCalled()
  })

  describe('requests in flight per user (security review 2026-11-01, finding 9)', () => {
    /** An upstream whose answers are held back until the test lets them go. */
    function held() {
      const waiting: ((response: Response) => void)[] = []
      const respond = () => new Promise<Response>((resolve) => waiting.push(resolve))
      return { respond, waiting, letGo: (n = 0, body = 'ok') => waiting[n]!(new Response(body)) }
    }
    const started = (seen: Seen[], n: number) => vi.waitFor(() => expect(seen).toHaveLength(n))

    it('answers 429 with Retry-After once a user has the maximum in flight, and logs it once', async () => {
      const upstream = held()
      const { call, seen, log } = setup(upstream.respond, { maxConcurrentPerUser: 2 })
      const first = call('REPORT', '/caldav/a/')
      const second = call('REPORT', '/caldav/b/')
      await started(seen, 2)

      const refused = await call('REPORT', '/caldav/c/')
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBe('1')
      expect((await call('REPORT', '/caldav/d/')).status).toBe(429)
      expect(seen).toHaveLength(2) // the refused ones never reached Radicale
      expect(log.mock.calls.filter(([message]) => /limit of requests/.test(message))).toHaveLength(
        1,
      )

      upstream.letGo(0)
      upstream.letGo(1)
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
    })

    it('keeps the slot until the answer has been read to its end', async () => {
      const answerBody = () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('data'))
            controller.close()
          },
        })
      const { call } = setup(() => new Response(answerBody()), { maxConcurrentPerUser: 1 })
      const answer = await call('REPORT', '/caldav/a/')
      expect(answer.status).toBe(200)
      // Headers are in, the body is not read: the request is still in flight.
      expect((await call('REPORT', '/caldav/b/')).status).toBe(429)
      expect(await answer.text()).toBe('data')
      expect((await call('REPORT', '/caldav/b/')).status).toBe(200)
    })

    it('gives the slot back when the client drops the answer', async () => {
      const { call } = setup(() => new Response('a large answer'), { maxConcurrentPerUser: 1 })
      const answer = await call('REPORT', '/caldav/a/')
      expect((await call('REPORT', '/caldav/b/')).status).toBe(429)
      await answer.body!.cancel()
      expect((await call('REPORT', '/caldav/b/')).status).toBe(200)
    })

    it('gives the slot back at once for an answer without a body', async () => {
      const { call } = setup(() => new Response(null, { status: 204 }), { maxConcurrentPerUser: 1 })
      for (let i = 0; i < 4; i += 1) {
        expect((await call('DELETE', `/caldav/a/${i}.ics`)).status).toBe(204)
      }
    })

    it('gives the slot back when Radicale fails, times out, or the path is refused', async () => {
      let mode: 'fail' | 'ok' = 'fail'
      const { call } = setup(
        () => {
          if (mode === 'fail') throw new Error('connection refused')
          return new Response('ok')
        },
        { maxConcurrentPerUser: 1 },
      )
      for (let i = 0; i < 3; i += 1) expect((await call('GET', '/caldav/a/')).status).toBe(502)
      for (let i = 0; i < 3; i += 1) expect((await call('GET', '/elsewhere/')).status).toBe(404)
      mode = 'ok'
      expect(await (await call('GET', '/caldav/a/')).text()).toBe('ok')
    })

    it('counts every user on their own', async () => {
      const upstream = held()
      const { call, seen } = setup(upstream.respond, { maxConcurrentPerUser: 1 })
      const mine = call('REPORT', '/caldav/a/')
      await started(seen, 1)
      expect((await call('REPORT', '/caldav/b/')).status).toBe(429)
      const theirs = call('REPORT', '/caldav/c/', { headers: { authorization: 'Bearer other' } })
      await started(seen, 2)
      upstream.letGo(0)
      upstream.letGo(1)
      expect((await mine).status).toBe(200)
      expect((await theirs).status).toBe(200)
    })

    it('does not use up a slot for a request that is not authenticated', async () => {
      const { call } = setup(undefined, { maxConcurrentPerUser: 1 })
      for (let i = 0; i < 5; i += 1) {
        expect((await call('PROPFIND', '/caldav/', { authorized: false })).status).toBe(401)
      }
      expect((await call('PROPFIND', '/caldav/')).status).toBe(200)
    })

    it('allows 8 at once by default and refuses the 9th', async () => {
      const upstream = held()
      const { call, seen } = setup(upstream.respond)
      const running = Array.from({ length: 8 }, (_, i) => call('REPORT', `/caldav/a/${i}/`))
      await started(seen, 8)
      expect((await call('REPORT', '/caldav/a/9/')).status).toBe(429)
      upstream.waiting.forEach((resolve) => resolve(new Response('ok')))
      for (const response of await Promise.all(running)) expect(response.status).toBe(200)
    })
  })

  describe('upstream timeout (security review 2026-11-01, finding 9)', () => {
    /** A Radicale that never answers: the request ends only when the gateway aborts it. */
    const silent = (seen: Seen) =>
      new Promise<Response>((_resolve, reject) => {
        seen.init.signal!.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })

    it('answers 504 when Radicale does not start answering in time, and logs it', async () => {
      const { call, log, seen } = setup(silent, { upstreamTimeoutMs: 20 })
      const response = await call('GET', '/caldav/alice/')
      expect(response.status).toBe(504)
      expect(await response.text()).toBe('Gateway Timeout')
      expect(log).toHaveBeenCalledWith('upstream did not answer within 20 ms')
      expect(seen[0]!.init.signal!.aborted).toBe(true)
    })

    it('times only the wait for the headers: a body that streams longer is not cut off', async () => {
      const slowBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('a'))
          await new Promise((resolve) => setTimeout(resolve, 80))
          controller.enqueue(encoder.encode('b'))
          controller.close()
        },
      })
      const { call } = setup(() => new Response(slowBody), { upstreamTimeoutMs: 20 })
      const response = await call('GET', '/caldav/alice/')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('ab')
    })

    it('still aborts the upstream request when the client goes away, and says 502, not 504', async () => {
      const client = new AbortController()
      const { call, log, seen } = setup(silent, { upstreamTimeoutMs: 60_000 })
      const pending = call('GET', '/caldav/alice/', { signal: client.signal })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      client.abort()
      const response = await pending
      expect(response.status).toBe(502)
      expect(seen[0]!.init.signal!.aborted).toBe(true)
      expect(log).not.toHaveBeenCalled()
    })

    it('has a default of 30 seconds', () => {
      expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBe(30_000)
    })
  })

  it('answers 403 and 404 from Radicale as they are', async () => {
    const { call } = setup(
      (seen) => new Response('x', { status: seen.method === 'GET' ? 404 : 403 }),
    )
    expect((await call('GET', '/caldav/alice/missing.ics')).status).toBe(404)
    expect((await call('PROPFIND', '/caldav/bob/')).status).toBe(403)
  })
})

describe('gateway: CORS', () => {
  const ORIGIN = 'https://app.example.org'
  const preflight = {
    origin: ORIGIN,
    'access-control-request-method': 'PROPFIND',
    'access-control-request-headers': 'authorization,depth',
  }

  it('adds no CORS headers at all by default, not even to a 401', async () => {
    const { call } = setup()
    for (const response of [
      await call('PROPFIND', '/caldav/', { authorized: false, headers: { origin: ORIGIN } }),
      await call('PROPFIND', '/caldav/', { headers: { origin: ORIGIN } }),
      await call('OPTIONS', '/caldav/', { authorized: false, headers: preflight }),
    ]) {
      expect(response.headers.has('access-control-allow-origin')).toBe(false)
      expect(response.headers.has('vary')).toBe(false)
    }
  })

  it('answers a preflight from an allowed origin without authentication', async () => {
    const { call, authenticate, fetchStub } = setup(undefined, { corsOrigins: [ORIGIN] })
    const response = await call('OPTIONS', '/caldav/', { authorized: false, headers: preflight })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('access-control-allow-methods')).toContain('PROPFIND')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(response.headers.get('vary')).toBe('Origin')
    expect(authenticate).not.toHaveBeenCalled()
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('puts the same CORS headers on a 401, so the browser sees the status', async () => {
    const { call } = setup(undefined, { corsOrigins: [ORIGIN] })
    const response = await call('PROPFIND', '/caldav/', {
      authorized: false,
      headers: { origin: ORIGIN },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate')
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('adds them to proxied answers and to gateway errors', async () => {
    const { call } = setup(undefined, { corsOrigins: [ORIGIN] })
    const ok = await call('PROPFIND', '/caldav/alice/', { headers: { origin: ORIGIN } })
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(ok.headers.get('access-control-expose-headers')).toContain('ETag')
    for (const [method, target, status] of [
      ['POST', '/caldav/alice/', 405],
      ['GET', '/caldav/../x', 400],
    ] as const) {
      const response = await call(method, target, { headers: { origin: ORIGIN } })
      expect(response.status).toBe(status)
      expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    }
  })

  it('does not answer a preflight from another origin; it gets the plain 401', async () => {
    const { call } = setup(undefined, { corsOrigins: [ORIGIN] })
    const response = await call('OPTIONS', '/caldav/', {
      authorized: false,
      headers: { ...preflight, origin: 'https://evil.example' },
    })
    expect(response.status).toBe(401)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('treats OPTIONS without a preflight header as the normal authenticated request', async () => {
    const { call, seen } = setup(undefined, { corsOrigins: [ORIGIN] })
    const unauthenticated = await call('OPTIONS', '/caldav/', {
      authorized: false,
      headers: { origin: ORIGIN },
    })
    expect(unauthenticated.status).toBe(401)
    const response = await call('OPTIONS', '/caldav/')
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
  })
})

describe('gateway: clients that fail Basic logins too often', () => {
  const ORIGIN = 'https://app.example.org'
  const ADDRESS = '203.0.113.9'
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`

  /** The gateway wired as in production: the real authentication with a real throttle in front of the app token check. */
  function wired(options: Partial<GatewayOptions> = {}) {
    const clock = { ms: 1_800_000_000_000 }
    const basicThrottle = createBasicThrottle({ now: () => clock.ms })
    const verifyAppToken = vi.fn((username: string, token: string) =>
      username === 'alice' && token === 'wcal_good' ? { sub: SUB } : null,
    )
    const authenticate = vi.fn((headers: Headers, context: { clientAddress: string | null }) =>
      authenticateRequest(headers, {
        verifier: {
          verify: async (token) => {
            if (token !== 'good') throw new AuthError('expired')
            return { sub: SUB, clientId: 'web-calendar', scopes: ['caldav'], exp: 1 }
          },
        },
        verifyAppToken,
        basicThrottle,
        clientAddress: context.clientAddress,
      }),
    )
    const fetchStub = vi.fn(async () => new Response('ok'))
    const log = vi.fn()
    const handle = createGateway({
      upstream: 'http://radicale:5232',
      maxBodyBytes: MAX,
      authenticate,
      fetch: fetchStub as unknown as typeof fetch,
      log,
      ...options,
    })
    const call = (
      authorization: string | undefined,
      extra: { clientAddress?: string | null; origin?: string } = {},
    ) =>
      handle({
        method: 'PROPFIND',
        target: '/caldav/',
        headers: new Headers({
          ...(authorization === undefined ? {} : { authorization }),
          ...(extra.origin === undefined ? {} : { origin: extra.origin }),
        }),
        body: null,
        clientAddress: 'clientAddress' in extra ? extra.clientAddress : ADDRESS,
      })
    return { call, clock, authenticate, verifyAppToken, fetchStub, log }
  }

  it('tells authenticate where the request came from, and null when it does not know', async () => {
    const { call, authenticate } = wired()
    await call('Bearer good')
    await call('Bearer good', { clientAddress: null })
    await call('Bearer good', { clientAddress: undefined })
    expect(authenticate.mock.calls.map(([, context]) => context)).toEqual([
      { clientAddress: ADDRESS },
      { clientAddress: null },
      { clientAddress: null },
    ])
  })

  /** Five failed logins of alice from `ADDRESS`; the fifth is the first one answered with 429. */
  async function fiveFailures(
    call: ReturnType<typeof wired>['call'],
    extra: { origin?: string } = {},
  ) {
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await call(basic('alice:wrong'), extra)).status)
    return statuses
  }

  it('answers 429 with Retry-After, no challenge and no detail to a failing login of a client that fails too often', async () => {
    const { call, fetchStub, verifyAppToken } = wired()
    expect(await fiveFailures(call)).toEqual([401, 401, 401, 401, 429])
    const response = await call(basic('alice:wrong-again'))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('600')
    expect(response.headers.has('www-authenticate')).toBe(false)
    expect(challengeLines(response)).toEqual([])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('Too Many Requests')
    expect(fetchStub).not.toHaveBeenCalled()
    // Every login was checked; the 429 says nothing about the credential.
    expect(verifyAppToken).toHaveBeenCalledTimes(6)
  })

  it('still lets a correct login through to Radicale while the client is throttled', async () => {
    const { call, fetchStub } = wired()
    await fiveFailures(call)
    expect((await call(basic('alice:wrong'))).status).toBe(429)
    const response = await call(basic('alice:wcal_good'))
    expect(response.status).toBe(200)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    // And it ended the block: the next failure is a plain 401 again.
    expect((await call(basic('alice:wrong'))).status).toBe(401)
  })

  it('stays reachable for a correct login when every request comes from one proxy address', async () => {
    const { call } = wired()
    for (let i = 0; i < 100; i++)
      await call(basic(`stranger${i}:wrong`), { clientAddress: '127.0.0.1' })
    for (let i = 0; i < 100; i++) await call(basic('alice:wrong'), { clientAddress: '127.0.0.1' })
    expect((await call(basic('alice:wcal_good'), { clientAddress: '127.0.0.1' })).status).toBe(200)
  })

  it('lets the failures of the client be answered with 401 again when Retry-After has passed', async () => {
    const { call, clock } = wired()
    await fiveFailures(call)
    clock.ms += 599_000
    const waiting = await call(basic('alice:wrong'))
    expect(waiting.status).toBe(429)
    expect(waiting.headers.get('retry-after')).toBe('1')
    clock.ms += 601_000
    expect((await call(basic('alice:wrong'))).status).toBe(401)
  })

  it('does not slow down bearer tokens or other clients', async () => {
    const { call } = wired()
    await fiveFailures(call)
    expect((await call('Bearer good')).status).toBe(200)
    expect((await call(basic('alice:wrong'), { clientAddress: '198.51.100.7' })).status).toBe(401)
    expect((await call(undefined)).status).toBe(401)
  })

  it('gives a 401 the two challenges as separate lines, Basic first', async () => {
    const { call } = wired()
    const response = await call(undefined)
    expect(response.status).toBe(401)
    expect(challengeLines(response)).toEqual([
      'Basic realm="Web Calendar"',
      'Bearer realm="Web Calendar"',
    ])
  })

  it('puts the same CORS headers on the 429 as on a 401, and exposes Retry-After', async () => {
    const { call } = wired({ corsOrigins: [ORIGIN] })
    const unauthorized = await call(undefined, { origin: ORIGIN })
    expect(unauthorized.status).toBe(401)
    await fiveFailures(call, { origin: ORIGIN })
    const response = await call(basic('alice:wrong'), { origin: ORIGIN })
    expect(response.status).toBe(429)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('access-control-expose-headers')).toContain('Retry-After')
    expect(response.headers.get('vary')).toBe('Origin')
    expect(response.headers.get('access-control-allow-origin')).toBe(
      unauthorized.headers.get('access-control-allow-origin'),
    )
    // From an origin that is not allowed it gets the Vary header only, like the 401.
    const other = await call(basic('alice:wrong'), { origin: 'https://evil.example' })
    expect(other.status).toBe(429)
    expect(other.headers.has('access-control-allow-origin')).toBe(false)
  })

  it('has no CORS headers when CORS is off', async () => {
    const { call } = wired()
    await fiveFailures(call, { origin: ORIGIN })
    const response = await call(basic('alice:wrong'), { origin: ORIGIN })
    expect(response.status).toBe(429)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.has('vary')).toBe(false)
  })

  it('logs each failed login that is answered with 401 and nothing for the 429s that follow', async () => {
    const { call, log } = wired()
    await fiveFailures(call)
    expect(log).toHaveBeenCalledTimes(4)
    for (let i = 0; i < 20; i++) await call(basic('alice:secret-guess'))
    expect(log).toHaveBeenCalledTimes(4)
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret-guess')
  })
})
