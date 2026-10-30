// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIcalProxy } from '../../server/utils/ical-proxy/cache'
import { IcalFetchError, type IcalFailureReason } from '../../server/utils/ical-proxy/errors'
import { fetchIcal, MAX_REDIRECTS, type FetchOptions } from '../../server/utils/ical-proxy/fetcher'
import {
  createAddressPolicy,
  isBlockedAddress,
  type AddressPolicy,
  type Resolver,
} from '../../server/utils/ical-proxy/ssrf'

// The fetcher against real HTTP servers on loopback. `lan` lets the connection reach them; `strict`
// is the production policy; `loopbackOnly` allows 127.0.0.1 and nothing else, so a redirect to the
// second server on 127.0.0.2 (the "victim") is a redirect to a blocked address that really exists.

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'

interface Hit {
  path: string
  method: string
  headers: IncomingMessage['headers']
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void

interface TestServer {
  server: Server
  port: number
  hits: Hit[]
  routes: Map<string, Handler>
  url(path: string): string
}

async function startServer(host: string): Promise<TestServer> {
  const hits: Hit[] = []
  const routes = new Map<string, Handler>()
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    hits.push({ path, method: request.method ?? '', headers: request.headers })
    const handler = routes.get(path.split('?')[0]!)
    if (handler) handler(request, response)
    else {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port, hits, routes, url: (path) => `http://${host}:${port}${path}` }
}

let source: TestServer
let victim: TestServer

const hostTable: Record<string, string> = {
  'feed.test': '127.0.0.1',
  'victim.test': '127.0.0.2',
  'metadata.test': '169.254.169.254',
}
const resolve: Resolver = async (hostname) => {
  const address = hostTable[hostname]
  if (!address) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
  }
  return [{ address, family: 4 }]
}

const lan = createAddressPolicy({ allowPrivate: true, resolve })
const strict = createAddressPolicy({ allowPrivate: false, resolve })
const loopbackOnly: AddressPolicy = {
  resolve,
  isBlockedAddress: (address) => address !== '127.0.0.1' && isBlockedAddress(address),
  isBlockedHostname: () => false,
}

beforeAll(async () => {
  source = await startServer('127.0.0.1')
  victim = await startServer('127.0.0.2')
})

afterAll(async () => {
  for (const { server } of [source, victim]) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
})

beforeEach(() => {
  for (const { hits, routes } of [source, victim]) {
    hits.length = 0
    routes.clear()
  }
})

function options(overrides: Partial<FetchOptions> = {}): FetchOptions {
  return { policy: lan, maxBytes: 1_000_000, timeoutMs: 2000, ...overrides }
}

function serve(path: string, body = ICS, headers: Record<string, string> = {}): void {
  source.routes.set(path, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/calendar', ...headers })
    response.end(body)
  })
}

function redirect(server: TestServer, path: string, location: string, status = 302): void {
  server.routes.set(path, (_request, response) => {
    response.writeHead(status, { location })
    response.end()
  })
}

async function failure(promise: Promise<unknown>): Promise<IcalFetchError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(IcalFetchError)
    return error as IcalFetchError
  }
  throw new Error('expected the fetch to fail')
}

async function reasonOf(promise: Promise<unknown>): Promise<IcalFailureReason> {
  return (await failure(promise)).reason
}

describe('fetchIcal: a successful fetch', () => {
  it('returns the body, the size and the validators of the source', async () => {
    serve('/cal.ics', ICS, { etag: '"v1"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' })
    const result = await fetchIcal(source.url('/cal.ics'), options())
    expect(result).toEqual({
      kind: 'ok',
      body: ICS,
      bytes: ICS.length,
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    })
  })

  it('sends a plain GET with the proxy headers and nothing that identifies the user', async () => {
    serve('/cal.ics')
    await fetchIcal(source.url('/cal.ics?x=1'), options())
    expect(source.hits).toHaveLength(1)
    const { method, path, headers } = source.hits[0]!
    expect(method).toBe('GET')
    expect(path).toBe('/cal.ics?x=1')
    expect(headers['user-agent']).toBe('web-calendar-ical-proxy')
    expect(headers.accept).toBe('text/calendar, text/plain;q=0.5')
    expect(headers['accept-encoding']).toBe('identity')
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(headers['content-length']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
    expect(headers['if-none-match']).toBeUndefined()
    expect(headers['if-modified-since']).toBeUndefined()
    expect(headers.host).toBe(`127.0.0.1:${source.port}`)
  })

  it('resolves names through the policy and connects to what it returned', async () => {
    serve('/cal.ics')
    const result = await fetchIcal(`http://feed.test:${source.port}/cal.ics`, options())
    expect(result.kind).toBe('ok')
    expect(source.hits[0]!.headers.host).toBe(`feed.test:${source.port}`)
  })

  it('accepts a byte order mark and leading white space before BEGIN:VCALENDAR', async () => {
    serve('/cal.ics', `\uFEFF\r\n  ${ICS}`)
    const result = await fetchIcal(source.url('/cal.ics'), options())
    expect(result).toMatchObject({ kind: 'ok' })
    expect((result as { body: string }).body.startsWith('\uFEFF')).toBe(false)
  })

  it('decodes UTF-8', async () => {
    const body = ICS.replace('END:VCALENDAR', 'X-WR-CALNAME:Größe ✓\r\nEND:VCALENDAR')
    serve('/cal.ics', body)
    const result = await fetchIcal(source.url('/cal.ics'), options())
    expect((result as { body: string }).body).toContain('Größe ✓')
  })

  it('accepts a body of exactly maxBytes', async () => {
    serve('/cal.ics')
    const result = await fetchIcal(source.url('/cal.ics'), options({ maxBytes: ICS.length }))
    expect(result.kind).toBe('ok')
  })
})

describe('fetchIcal: redirects', () => {
  it('follows a chain of three redirects, relative ones included', async () => {
    redirect(source, '/a', '/b', 301)
    redirect(source, '/b', source.url('/c'), 302)
    redirect(source, '/c', '/d?x=1#frag', 307)
    serve('/d')
    const result = await fetchIcal(source.url('/a'), options())
    expect(result.kind).toBe('ok')
    expect(source.hits.map((hit) => hit.path)).toEqual(['/a', '/b', '/c', '/d?x=1'])
    expect(MAX_REDIRECTS).toBe(3)
  })

  it.each([301, 302, 303, 307, 308])('follows a %i', async (status) => {
    redirect(source, '/a', '/b', status)
    serve('/b')
    expect((await fetchIcal(source.url('/a'), options())).kind).toBe('ok')
  })

  it('refuses a fourth redirect', async () => {
    redirect(source, '/a', '/b')
    redirect(source, '/b', '/c')
    redirect(source, '/c', '/d')
    redirect(source, '/d', '/e')
    serve('/e')
    const error = await failure(fetchIcal(source.url('/a'), options()))
    expect(error.reason).toBe('unreachable')
    expect(error.detail).toMatch(/redirects/)
    expect(source.hits.map((hit) => hit.path)).toEqual(['/a', '/b', '/c', '/d'])
  })

  it('stops a redirect loop', async () => {
    redirect(source, '/loop', '/loop')
    expect(await reasonOf(fetchIcal(source.url('/loop'), options()))).toBe('unreachable')
    expect(source.hits).toHaveLength(MAX_REDIRECTS + 1)
  })

  it('does not forward credentials or cookies to the next hop', async () => {
    source.routes.set('/a', (_request, response) => {
      response.writeHead(302, { location: '/b', 'set-cookie': 'session=1' })
      response.end()
    })
    serve('/b')
    await fetchIcal(source.url('/a'), options())
    expect(source.hits[1]!.headers.cookie).toBeUndefined()
    expect(source.hits[1]!.headers.authorization).toBeUndefined()
  })

  it('answers http-<status> to a redirect without Location', async () => {
    source.routes.set('/a', (_request, response) => {
      response.writeHead(302)
      response.end()
    })
    expect(await reasonOf(fetchIcal(source.url('/a'), options()))).toBe('http-302')
  })

  it('treats an unusable Location as unreachable', async () => {
    redirect(source, '/a', 'http://[::1')
    expect(await reasonOf(fetchIcal(source.url('/a'), options()))).toBe('unreachable')
  })

  describe('to an address that is not allowed', () => {
    it.each([
      ['an IP literal (loopback)', () => `http://127.0.0.2:${victim.port}/secret`],
      ['an IP literal in decimal notation', () => `http://2130706434:${victim.port}/secret`],
      ['an IP literal in hex notation', () => `http://0x7f000002:${victim.port}/secret`],
      ['an IPv4-mapped IPv6 literal', () => `http://[::ffff:7f00:2]:${victim.port}/secret`],
      ['a name that resolves to it', () => `http://victim.test:${victim.port}/secret`],
      ['the cloud metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
      ['the cloud metadata address behind a name', () => 'http://metadata.test/latest/meta-data/'],
      ['localhost', () => `http://localhost:${victim.port}/secret`],
    ])('is blocked when the target is %s, and nothing connects to it', async (_label, target) => {
      victim.routes.set('/secret', (_request, response) => response.end(ICS))
      redirect(source, '/a', target())
      const policy: AddressPolicy = {
        ...loopbackOnly,
        isBlockedHostname: (name) => name === 'localhost',
      }
      expect(await reasonOf(fetchIcal(source.url('/a'), options({ policy })))).toBe('blocked')
      expect(victim.hits).toEqual([])
      expect(source.hits).toHaveLength(1)
    })

    it('is blocked on a later hop of the chain', async () => {
      victim.routes.set('/secret', (_request, response) => response.end(ICS))
      redirect(source, '/a', '/b')
      redirect(source, '/b', `http://victim.test:${victim.port}/secret`)
      expect(await reasonOf(fetchIcal(source.url('/a'), options({ policy: loopbackOnly })))).toBe(
        'blocked',
      )
      expect(victim.hits).toEqual([])
    })

    it.each([
      ['file:///etc/passwd'],
      ['ftp://example.com/cal.ics'],
      ['gopher://example.com/'],
      ['javascript:alert(1)'],
      ['data:text/calendar,BEGIN:VCALENDAR'],
    ])('is blocked when the target is %s', async (target) => {
      redirect(source, '/a', target)
      expect(await reasonOf(fetchIcal(source.url('/a'), options()))).toBe('blocked')
    })

    it('is blocked when the target carries credentials', async () => {
      victim.routes.set('/secret', (_request, response) => response.end(ICS))
      redirect(source, '/a', `http://user:pw@127.0.0.1:${source.port}/b`)
      serve('/b')
      expect(await reasonOf(fetchIcal(source.url('/a'), options()))).toBe('blocked')
      expect(source.hits.map((hit) => hit.path)).toEqual(['/a'])
    })
  })
})

describe('fetchIcal: the guard on the first request', () => {
  it.each([
    ['an IPv4 literal', () => `http://127.0.0.1:${source.port}/cal.ics`],
    ['a decimal IPv4 literal', () => `http://2130706433:${source.port}/cal.ics`],
    ['a hex IPv4 literal', () => `http://0x7f.1:${source.port}/cal.ics`],
    ['an IPv4-mapped IPv6 literal', () => `http://[::ffff:127.0.0.1]:${source.port}/cal.ics`],
    ['localhost', () => `http://localhost:${source.port}/cal.ics`],
    ['a name that resolves to loopback', () => `http://feed.test:${source.port}/cal.ics`],
    ['the metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
  ])('refuses %s without allowPrivate and sends nothing', async (_label, url) => {
    serve('/cal.ics')
    expect(await reasonOf(fetchIcal(url(), options({ policy: strict })))).toBe('blocked')
    expect(source.hits).toEqual([])
  })

  it('refuses a name with a blocked address even when another one is public', async () => {
    serve('/cal.ics')
    const mixed = createAddressPolicy({
      allowPrivate: false,
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })
    expect(
      await reasonOf(
        fetchIcal(`http://mixed.test:${source.port}/cal.ics`, options({ policy: mixed })),
      ),
    ).toBe('blocked')
    expect(source.hits).toEqual([])
  })

  it.each([
    ['file:///etc/passwd'],
    ['ftp://example.com/cal.ics'],
    ['javascript:alert(1)'],
    ['http://user:pass@127.0.0.1/cal.ics'],
  ])('refuses the stored address %s even with allowPrivate', async (url) => {
    expect(await reasonOf(fetchIcal(url, options()))).toBe('blocked')
  })

  it('reports a stored address that is not a URL as unreachable', async () => {
    expect(await reasonOf(fetchIcal('not a url', options()))).toBe('unreachable')
  })

  it('reports a name that does not resolve as unreachable', async () => {
    expect(await reasonOf(fetchIcal('http://nowhere.test/cal.ics', options()))).toBe('unreachable')
  })

  it('reports a refused connection as unreachable', async () => {
    const closed = await startServer('127.0.0.1')
    const url = closed.url('/cal.ics')
    await new Promise((done) => closed.server.close(done))
    const error = await failure(fetchIcal(url, options()))
    expect(error.reason).toBe('unreachable')
    expect(error.detail).toBe('ECONNREFUSED')
  })

  it('goes through the TLS stack for https and fails on a plain-text server', async () => {
    serve('/cal.ics')
    const error = await failure(fetchIcal(`https://127.0.0.1:${source.port}/cal.ics`, options()))
    expect(error.reason).toBe('unreachable')
    expect(source.hits).toEqual([])
  })
})

describe('fetchIcal: limits', () => {
  it('refuses a Content-Length over the limit without reading the body', async () => {
    let closed = false
    source.routes.set('/big', (_request, response) => {
      response.writeHead(200, { 'content-length': String(10_000_000) })
      response.write('BEGIN:VCALENDAR\r\n')
      response.on('close', () => {
        closed = true
      })
    })
    expect(await reasonOf(fetchIcal(source.url('/big'), options({ maxBytes: 1000 })))).toBe(
      'too-large',
    )
    await expect.poll(() => closed).toBe(true)
  })

  it('stops reading a streamed body as soon as it exceeds the limit', async () => {
    let written = 0
    let closed = false
    source.routes.set('/stream', (_request, response) => {
      response.writeHead(200) // no Content-Length: chunked
      response.write('BEGIN:VCALENDAR\r\n')
      const timer = setInterval(() => {
        written += 1024
        response.write('X'.repeat(1024))
      }, 1)
      response.on('close', () => {
        closed = true
        clearInterval(timer)
      })
    })
    expect(await reasonOf(fetchIcal(source.url('/stream'), options({ maxBytes: 4096 })))).toBe(
      'too-large',
    )
    await expect.poll(() => closed).toBe(true)
    // The server noticed the abort long before it had written anything near a megabyte.
    expect(written).toBeLessThan(1_000_000)
  })

  it('refuses one byte over the limit', async () => {
    serve('/cal.ics')
    expect(
      await reasonOf(fetchIcal(source.url('/cal.ics'), options({ maxBytes: ICS.length - 1 }))),
    ).toBe('too-large')
  })

  it('times out when the source never answers', async () => {
    source.routes.set('/hang', () => {})
    const started = Date.now()
    expect(await reasonOf(fetchIcal(source.url('/hang'), options({ timeoutMs: 100 })))).toBe(
      'timeout',
    )
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('times out when the body stalls', async () => {
    source.routes.set('/stall', (_request, response) => {
      response.writeHead(200)
      response.write('BEGIN:VCALENDAR\r\n')
    })
    expect(await reasonOf(fetchIcal(source.url('/stall'), options({ timeoutMs: 100 })))).toBe(
      'timeout',
    )
  })

  it('applies one deadline to all hops together', async () => {
    const slow = (path: string, next: (response: ServerResponse) => void): void => {
      source.routes.set(path, (_request, response) => {
        setTimeout(() => next(response), 80)
      })
    }
    slow('/one', (response) => {
      response.writeHead(302, { location: '/two' })
      response.end()
    })
    slow('/two', (response) => {
      response.writeHead(302, { location: '/three' })
      response.end()
    })
    serve('/three')
    // Each hop takes 80 ms, inside 120 ms; together they do not.
    expect(await reasonOf(fetchIcal(source.url('/one'), options({ timeoutMs: 120 })))).toBe(
      'timeout',
    )
    // And the same chain passes with a deadline for all of it.
    expect((await fetchIcal(source.url('/one'), options({ timeoutMs: 2000 }))).kind).toBe('ok')
  })

  it('reports a connection that drops mid-body as unreachable', async () => {
    source.routes.set('/drop', (_request, response) => {
      response.writeHead(200, { 'content-length': '1000' })
      response.write('BEGIN:VCALENDAR\r\n')
      setTimeout(() => response.destroy(), 10)
    })
    expect(await reasonOf(fetchIcal(source.url('/drop'), options()))).toBe('unreachable')
  })
})

describe('fetchIcal: what the source answers', () => {
  it.each([
    ['text/html', '<!doctype html><html><body>Please log in</body></html>'],
    ['text/plain', 'just some text'],
    ['application/json', '{"BEGIN":"VCALENDAR"}'],
    ['text/calendar', ''],
    ['text/calendar', '   \r\n  '],
    ['text/calendar', 'X-NOTE:BEGIN:VCALENDAR'],
    ['application/octet-stream', '\u0000\u0001\u0002'],
  ])('rejects a 200 with a %s body that is not a calendar', async (_type, body) => {
    serve('/cal.ics', body)
    expect(await reasonOf(fetchIcal(source.url('/cal.ics'), options()))).toBe('not-ical')
  })

  it('rejects a compressed body it did not ask for', async () => {
    source.routes.set('/zipped', (_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' })
      response.end(gzipSync(ICS))
    })
    const error = await failure(fetchIcal(source.url('/zipped'), options()))
    expect(error.reason).toBe('not-ical')
    expect(error.detail).toMatch(/Content-Encoding/)
  })

  it.each([204, 206, 400, 401, 403, 404, 410, 429, 500, 502, 503])(
    'reports http-%i',
    async (status) => {
      source.routes.set('/cal.ics', (_request, response) => {
        response.writeHead(status)
        response.end(ICS)
      })
      expect(await reasonOf(fetchIcal(source.url('/cal.ics'), options()))).toBe(`http-${status}`)
    },
  )

  it('does not take a calendar from an error page', async () => {
    source.routes.set('/cal.ics', (_request, response) => {
      response.writeHead(500)
      response.end(ICS)
    })
    expect(await reasonOf(fetchIcal(source.url('/cal.ics'), options()))).toBe('http-500')
  })
})

describe('fetchIcal: conditional requests', () => {
  const validators = { etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' }

  it('sends the validators and returns not-modified for a 304', async () => {
    source.routes.set('/cal.ics', (_request, response) => {
      response.writeHead(304, { etag: '"v1"' })
      response.end()
    })
    const result = await fetchIcal(source.url('/cal.ics'), options({ validators }))
    expect(result).toEqual({ kind: 'not-modified', etag: '"v1"', lastModified: null })
    expect(source.hits[0]!.headers['if-none-match']).toBe('"v1"')
    expect(source.hits[0]!.headers['if-modified-since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT')
  })

  it('sends only the validator it has', async () => {
    serve('/cal.ics')
    await fetchIcal(
      source.url('/cal.ics'),
      options({ validators: { etag: null, lastModified: validators.lastModified } }),
    )
    expect(source.hits[0]!.headers['if-none-match']).toBeUndefined()
    expect(source.hits[0]!.headers['if-modified-since']).toBe(validators.lastModified)
  })

  it('returns the new body when the source has one', async () => {
    serve('/cal.ics', ICS, { etag: '"v2"' })
    const result = await fetchIcal(source.url('/cal.ics'), options({ validators }))
    expect(result).toMatchObject({ kind: 'ok', etag: '"v2"' })
  })

  it('takes a 304 for an unconditional request as a source error', async () => {
    source.routes.set('/cal.ics', (_request, response) => {
      response.writeHead(304)
      response.end()
    })
    expect(await reasonOf(fetchIcal(source.url('/cal.ics'), options()))).toBe('http-304')
    expect(
      await reasonOf(
        fetchIcal(
          source.url('/cal.ics'),
          options({ validators: { etag: null, lastModified: null } }),
        ),
      ),
    ).toBe('http-304')
  })
})

// The cache with the real fetcher: what the source sees, with a clock the test moves by hand.
describe('IcalProxy against a real source', () => {
  const TTL_SEC = 300
  let clock = 0

  function proxy(overrides: { cacheTtlSec?: number; policy?: AddressPolicy } = {}) {
    const logs: string[] = []
    clock = 1_000_000
    return {
      logs,
      proxy: createIcalProxy({
        config: {
          cacheTtlSec: overrides.cacheTtlSec ?? TTL_SEC,
          maxBytes: 1_000_000,
          timeoutMs: 2000,
          allowPrivate: true,
        },
        policy: overrides.policy ?? lan,
        now: () => clock,
        log: (message) => logs.push(message),
      }),
    }
  }

  const user = { userId: 1, subscriptionId: 7 }
  const advance = (seconds: number) => {
    clock += seconds * 1000
  }

  it('serves from the cache within the TTL and asks the source again after it', async () => {
    serve('/cal.ics', ICS, { etag: '"v1"' })
    const { proxy: cache } = proxy()
    const url = source.url('/cal.ics')

    expect(await cache.get(url, user)).toEqual({ body: ICS, etag: '"v1"' })
    advance(TTL_SEC - 1)
    expect(await cache.get(url, user)).toEqual({ body: ICS, etag: '"v1"' })
    expect(source.hits).toHaveLength(1)

    advance(2)
    await cache.get(url, user)
    expect(source.hits).toHaveLength(2)
  })

  it('revalidates with the stored validators and keeps the body on a 304', async () => {
    let version = 1
    source.routes.set('/cal.ics', (request, response) => {
      if (request.headers['if-none-match'] === `"v${version}"`) {
        response.writeHead(304, { etag: `"v${version}"` })
        response.end()
        return
      }
      response.writeHead(200, {
        etag: `"v${version}"`,
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      })
      response.end(ICS.replace('VERSION:2.0', `X-VERSION:${version}`))
    })
    const { proxy: cache } = proxy()
    const url = source.url('/cal.ics')

    const first = await cache.get(url, user)
    expect(first.body).toContain('X-VERSION:1')

    advance(TTL_SEC + 1)
    const second = await cache.get(url, user)
    expect(second).toEqual(first)
    expect(source.hits[1]!.headers['if-none-match']).toBe('"v1"')
    expect(source.hits[1]!.headers['if-modified-since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT')

    // A 304 renews the entry: the next request within the TTL asks nobody.
    advance(10)
    await cache.get(url, user)
    expect(source.hits).toHaveLength(2)

    // The source changed: the new body replaces the old one.
    version = 2
    advance(TTL_SEC + 1)
    const third = await cache.get(url, user)
    expect(third.body).toContain('X-VERSION:2')
    expect(third.etag).toBe('"v2"')
  })

  it('never serves a stale copy when the source fails', async () => {
    let failing = false
    source.routes.set('/cal.ics', (_request, response) => {
      response.writeHead(failing ? 503 : 200)
      response.end(ICS)
    })
    const { proxy: cache, logs } = proxy()
    const url = source.url('/cal.ics')
    await cache.get(url, user)

    failing = true
    advance(TTL_SEC + 1)
    await expect(cache.get(url, user)).rejects.toMatchObject({ reason: 'http-503' })
    expect(cache.stats().entries).toBe(0)
    // Still failing, still an error: the old copy is gone, not hidden.
    await expect(cache.get(url, user)).rejects.toMatchObject({ reason: 'http-503' })

    failing = false
    expect((await cache.get(url, user)).body).toBe(ICS)
    expect(logs).toHaveLength(2)
  })

  it('does not serve the cached copy of a feed that turned into something else', async () => {
    let body = ICS
    source.routes.set('/cal.ics', (_request, response) => {
      response.writeHead(200)
      response.end(body)
    })
    const { proxy: cache } = proxy()
    await cache.get(source.url('/cal.ics'), user)
    body = '<html>maintenance</html>'
    advance(TTL_SEC + 1)
    await expect(cache.get(source.url('/cal.ics'), user)).rejects.toMatchObject({
      reason: 'not-ical',
    })
  })

  it('lets concurrent requests for one address share a single fetch', async () => {
    source.routes.set('/cal.ics', (_request, response) => {
      setTimeout(() => {
        response.writeHead(200)
        response.end(ICS)
      }, 50)
    })
    const { proxy: cache } = proxy()
    const url = source.url('/cal.ics')
    const results = await Promise.all([
      cache.get(url, user),
      cache.get(url, user),
      cache.get(url, { userId: 2, subscriptionId: 9 }),
      cache.get(url, user),
    ])
    expect(source.hits).toHaveLength(1)
    expect(new Set(results.map((result) => result.body)).size).toBe(1)
    expect(cache.stats().inFlight).toBe(0)
  })

  it('shares a failure the same way, and tries again afterwards', async () => {
    let calls = 0
    source.routes.set('/cal.ics', (_request, response) => {
      calls++
      setTimeout(() => {
        response.writeHead(500)
        response.end()
      }, 30)
    })
    const { proxy: cache } = proxy()
    const url = source.url('/cal.ics')
    const outcomes = await Promise.allSettled([cache.get(url, user), cache.get(url, user)])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toBe(1)
    await expect(cache.get(url, user)).rejects.toMatchObject({ reason: 'http-500' })
    expect(calls).toBe(2)
  })

  it('refuses private addresses with the production policy and logs only the host', async () => {
    serve('/private-token-123/cal.ics')
    const { proxy: cache, logs } = proxy({ policy: strict })
    await expect(
      cache.get(source.url('/private-token-123/cal.ics?key=SECRET'), user),
    ).rejects.toMatchObject({ reason: 'blocked' })
    expect(source.hits).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('sub 7')
    expect(logs[0]).toContain(`host=127.0.0.1:${source.port}`)
    expect(logs[0]).toContain('blocked')
    expect(logs[0]).not.toContain('private-token-123')
    expect(logs[0]).not.toContain('SECRET')
  })
})
