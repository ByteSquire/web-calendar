// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDiscoveryStore,
  discoveryUrl,
  fetchDiscovery,
} from '../../server/utils/auth/discovery'

const ISSUER = 'https://idm.example.test/oauth2/openid/web-calendar'
const DOC = {
  issuer: ISSUER,
  jwks_uri: `${ISSUER}/public_key.jwk`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
}

interface Call {
  url: string
  init: RequestInit | undefined
}

/** A fetch that answers every request with `body`, and the requests it saw. */
function answering(body: unknown, init: ResponseInit = {}) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: string, requestInit?: RequestInit) => {
    calls.push({ url, init: requestInit })
    const text = body === null || typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status: 200, ...init })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const message = (promise: Promise<unknown>) =>
  promise.then(
    () => '',
    (error: unknown) => (error as Error).message,
  )

describe('discoveryUrl', () => {
  it.each([
    [ISSUER, `${ISSUER}/.well-known/openid-configuration`],
    ['https://a.test/', 'https://a.test/.well-known/openid-configuration'],
    ['https://a.test/realms/x//', 'https://a.test/realms/x/.well-known/openid-configuration'],
  ])('joins the path to %s', (issuer, expected) => {
    expect(discoveryUrl(issuer)).toBe(expected)
  })
})

describe('fetchDiscovery: the document', () => {
  it('returns the issuer, the key set and the userinfo endpoint, asking without a redirect', async () => {
    const { fetch, calls } = answering(DOC)
    await expect(fetchDiscovery(ISSUER, { fetch })).resolves.toEqual({
      issuer: ISSUER,
      jwksUri: `${ISSUER}/public_key.jwk`,
      userinfoEndpoint: `${ISSUER}/userinfo`,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${ISSUER}/.well-known/openid-configuration`)
    expect(calls[0]!.init).toMatchObject({ redirect: 'error' })
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('takes a document without a userinfo endpoint', async () => {
    const { fetch } = answering({ issuer: ISSUER, jwks_uri: DOC.jwks_uri })
    expect((await fetchDiscovery(ISSUER, { fetch })).userinfoEndpoint).toBeNull()
  })

  it('keeps a trailing slash of the issuer: only the join drops it', async () => {
    const issuer = 'https://tenant.auth0.example/'
    const { fetch, calls } = answering({
      issuer,
      jwks_uri: 'https://tenant.auth0.example/.well-known/jwks.json',
    })
    const document = await fetchDiscovery(issuer, { fetch })
    expect(document.issuer).toBe(issuer)
    expect(calls[0]!.url).toBe('https://tenant.auth0.example/.well-known/openid-configuration')
    // The same host without the slash is another issuer string, and refused.
    expect(await message(fetchDiscovery('https://tenant.auth0.example', { fetch }))).toMatch(
      /document is for the issuer/,
    )
  })

  it.each([
    ['another realm', `${ISSUER}-other`],
    ['a trailing slash the configuration does not have', `${ISSUER}/`],
    ['another case', ISSUER.toUpperCase()],
    ['no issuer', undefined],
    ['a number', 42],
    ['an array', [ISSUER]],
  ])('refuses a document whose issuer is %s', async (_name, issuer) => {
    const { fetch } = answering({ ...DOC, issuer })
    expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(
      /^discovery: the document is for the issuer/,
    )
  })

  it.each([
    ['missing', undefined, /jwks_uri is missing/],
    ['empty', '', /jwks_uri is missing/],
    ['a number', 1, /jwks_uri is missing/],
    ['relative', '/keys', /jwks_uri is not an absolute URL/],
    ['plain http for an https issuer', 'http://idm.example.test/keys', /jwks_uri is not an https/],
    ['ftp', 'ftp://idm.example.test/keys', /jwks_uri is not an https/],
    ['with credentials', 'https://user:pw@idm.example.test/keys', /carries credentials/],
    ['with a fragment', 'https://idm.example.test/keys#x', /has a fragment/],
  ])('refuses a jwks_uri that is %s', async (_name, jwks_uri, pattern) => {
    const { fetch } = answering({ ...DOC, jwks_uri })
    expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(pattern)
  })

  it('takes the keys from the issuer’s own host only', async () => {
    const withKeys = (jwks_uri: string) => answering({ ...DOC, jwks_uri }).fetch
    // Another path, another port and another letter case are still the same host.
    for (const uri of [
      'https://idm.example.test/keys',
      'https://idm.example.test:8443/keys',
      'https://IDM.Example.TEST/keys',
    ]) {
      await expect(fetchDiscovery(ISSUER, { fetch: withKeys(uri) }), uri).resolves.toMatchObject({
        jwksUri: uri,
      })
    }
    // Another host, a subdomain, the parent domain, look-alikes and an address are not.
    for (const uri of [
      'https://keys.example.test/keys',
      'https://sub.idm.example.test/keys',
      'https://example.test/keys',
      'https://idm.example.test.evil.example/keys',
      'https://idm-example.test/keys',
      'https://203.0.113.9/keys',
    ]) {
      expect(await message(fetchDiscovery(ISSUER, { fetch: withKeys(uri) })), uri).toMatch(
        /^discovery: jwks_uri is on another host than the issuer/,
      )
    }
  })

  it('takes keys from a host the operator names, and from no other', async () => {
    const withKeys = (jwks_uri: string) => answering({ ...DOC, jwks_uri }).fetch
    const jwksHosts = ['www.googleapis.com', ' Keys.Example.TEST ']
    for (const uri of [
      'https://www.googleapis.com/oauth2/v3/certs',
      'https://keys.example.test/jwks',
      'https://idm.example.test/keys', // the issuer's own host stays allowed
    ]) {
      await expect(
        fetchDiscovery(ISSUER, { fetch: withKeys(uri), jwksHosts }),
        uri,
      ).resolves.toMatchObject({
        jwksUri: uri,
      })
    }
    // Exact names: not a subdomain, the parent domain, a look-alike or another host.
    for (const uri of [
      'https://oauth2.www.googleapis.com/certs',
      'https://googleapis.com/certs',
      'https://www.googleapis.com.evil.example/certs',
      'https://evil.example/certs',
    ]) {
      expect(
        await message(fetchDiscovery(ISSUER, { fetch: withKeys(uri), jwksHosts })),
        uri,
      ).toMatch(/another host than the issuer.*NUXT_OIDC_JWKS_HOSTS/)
    }
    // Naming a host relaxes nothing else: the URL still has to be https and carry no credentials.
    for (const [uri, pattern] of [
      ['http://www.googleapis.com/certs', /not an https/],
      ['https://user:pw@www.googleapis.com/certs', /carries credentials/],
    ] as const) {
      expect(
        await message(fetchDiscovery(ISSUER, { fetch: withKeys(uri), jwksHosts })),
        uri,
      ).toMatch(pattern)
    }
  })

  it('lets the userinfo endpoint be on another host (Entra’s is Microsoft Graph)', async () => {
    const endpoint = 'https://graph.example.test/oidc/userinfo'
    const { fetch } = answering({ ...DOC, userinfo_endpoint: endpoint })
    await expect(fetchDiscovery(ISSUER, { fetch })).resolves.toMatchObject({
      userinfoEndpoint: endpoint,
    })
  })

  it.each([
    ['plain http', 'http://idm.example.test/userinfo'],
    ['a number', 7],
    ['empty', ''],
    ['relative', 'userinfo'],
  ])('refuses a userinfo_endpoint that is %s', async (_name, userinfo_endpoint) => {
    const { fetch } = answering({ ...DOC, userinfo_endpoint })
    expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(/userinfo_endpoint/)
  })

  it('allows plain http endpoints only for an http issuer (the local test stack)', async () => {
    const issuer = 'http://127.0.0.1:9/oauth2/openid/web-calendar'
    const http = answering({ issuer, jwks_uri: `${issuer}/public_key.jwk` })
    await expect(fetchDiscovery(issuer, { fetch: http.fetch })).resolves.toMatchObject({
      jwksUri: `${issuer}/public_key.jwk`,
    })
    const https = answering({ issuer, jwks_uri: 'https://127.0.0.1/jwks' })
    await expect(fetchDiscovery(issuer, { fetch: https.fetch })).resolves.toBeDefined()
    const other = answering({ issuer, jwks_uri: 'ftp://127.0.0.1/jwks' })
    expect(await message(fetchDiscovery(issuer, { fetch: other.fetch }))).toMatch(/neither an http/)
  })

  it('refuses an issuer that is not a URL without asking anybody', async () => {
    const { fetch } = answering(DOC)
    expect(await message(fetchDiscovery('idm.example.test', { fetch }))).toMatch(/not a URL/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('fetchDiscovery: the answer', () => {
  it.each([404, 500, 204, 201, 304])('refuses HTTP %i', async (status) => {
    const { fetch } = answering(status === 204 || status === 304 ? null : DOC, { status })
    expect(await message(fetchDiscovery(ISSUER, { fetch }))).toBe(
      `discovery: the request failed (HTTP ${status})`,
    )
  })

  it.each([
    ['not JSON', '<html>'],
    ['empty', ''],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a number', '1'],
  ])('refuses an answer that is %s', async (_name, body) => {
    const { fetch } = answering(body)
    expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(
      /^discovery: the answer is not (JSON|a JSON object)$/,
    )
  })

  it('refuses a body that is not UTF-8', async () => {
    const fetch = vi.fn(
      async () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
    ) as unknown as typeof globalThis.fetch
    expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(/not UTF-8/)
  })

  it('reports a network error and a timeout', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    expect(await message(fetchDiscovery(ISSUER, { fetch: down }))).toBe(
      'discovery: the request failed (connect ECONNREFUSED)',
    )
    // A fetch that honours the abort signal, as the real one does.
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    ) as unknown as typeof globalThis.fetch
    expect(await message(fetchDiscovery(ISSUER, { fetch: hanging, timeoutMs: 20 }))).toBe(
      'discovery: the request failed (timed out)',
    )
  })

  describe('the size limit', () => {
    const body = JSON.stringify(DOC)
    const size = Buffer.byteLength(body)

    it('allows exactly the limit and refuses one byte more', async () => {
      const { fetch } = answering(body)
      await expect(fetchDiscovery(ISSUER, { fetch, maxBytes: size })).resolves.toBeDefined()
      expect(await message(fetchDiscovery(ISSUER, { fetch, maxBytes: size - 1 }))).toMatch(
        /larger than/,
      )
    })

    it('stops at a declared length that is too large and drops the download', async () => {
      const cancelled = vi.fn()
      const fetch = vi.fn(async () => {
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(10))
          },
          cancel: cancelled,
        })
        return new Response(stream, { headers: { 'content-length': '70000' } })
      }) as unknown as typeof globalThis.fetch
      expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(/larger than 65536/)
      expect(cancelled).toHaveBeenCalledTimes(1)
    })

    it('drops the download of an answer it refuses by status', async () => {
      const cancelled = vi.fn()
      const fetch = vi.fn(
        async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 500 }),
      ) as unknown as typeof globalThis.fetch
      expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(/HTTP 500/)
      expect(cancelled).toHaveBeenCalledTimes(1)
    })

    it('stops reading a long body that declares no length', async () => {
      // 4 MiB in 1 KiB chunks, then the end: long enough to show whether the limit stops the read.
      let chunks = 0
      const fetch = vi.fn(async () => {
        const stream = new ReadableStream({
          pull(controller) {
            chunks += 1
            controller.enqueue(new Uint8Array(1024).fill(0x20))
            if (chunks === 4096) controller.close()
          },
        })
        return new Response(stream)
      }) as unknown as typeof globalThis.fetch
      expect(await message(fetchDiscovery(ISSUER, { fetch }))).toMatch(/larger than 65536/)
      // The default limit is 64 KiB: about 64 chunks plus the ones the stream had ready.
      expect(chunks).toBeLessThan(200)
    })
  })
})

// The real fetch, against a local server: redirects and slow answers behave as in production.
describe('fetchDiscovery: over HTTP', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = undefined
  })

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler)
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/realm`
  }

  it('reads a document from a real server', async () => {
    let issuer = ''
    issuer = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys` }))
    })
    await expect(fetchDiscovery(issuer)).resolves.toMatchObject({ jwksUri: `${issuer}/keys` })
  })

  it('does not follow a redirect', async () => {
    const hits: string[] = []
    const issuer = await serve((request, response) => {
      hits.push(request.url ?? '')
      if (request.url?.startsWith('/elsewhere')) {
        response.writeHead(200).end('{}')
        return
      }
      response.writeHead(302, { location: '/elsewhere' }).end()
    })
    expect(await message(fetchDiscovery(issuer))).toMatch(/^discovery: the request failed/)
    expect(hits).toEqual(['/realm/.well-known/openid-configuration'])
  })

  it('gives up on a server that never answers', async () => {
    const issuer = await serve(() => {
      // No response at all.
    })
    expect(await message(fetchDiscovery(issuer, { timeoutMs: 100 }))).toBe(
      'discovery: the request failed (timed out)',
    )
  })

  it('gives up on a body that starts and then stalls', async () => {
    const issuer = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"issuer":')
    })
    expect(await message(fetchDiscovery(issuer, { timeoutMs: 100 }))).toBe(
      'discovery: the request failed (timed out)',
    )
  })
})

describe('createDiscoveryStore', () => {
  it('remembers the last good document per issuer and keeps it when a refresh fails', async () => {
    const other = 'https://other.example.test/oauth2/openid/other'
    let reply: unknown = DOC
    const fetch = vi.fn(async (url: string) => {
      if (reply === 'down') throw new TypeError('connect ECONNREFUSED')
      const doc = url.startsWith(other) ? { issuer: other, jwks_uri: `${other}/keys` } : reply
      return new Response(JSON.stringify(doc))
    }) as unknown as typeof globalThis.fetch
    const store = createDiscoveryStore({ fetch })

    expect(store.current(ISSUER)).toBeUndefined()
    await store.refresh(ISSUER)
    await store.refresh(other)
    expect(store.current(ISSUER)?.jwksUri).toBe(DOC.jwks_uri)
    expect(store.current(other)?.jwksUri).toBe(`${other}/keys`)

    reply = 'down'
    await expect(store.refresh(ISSUER)).rejects.toThrow(/the request failed/)
    expect(store.current(ISSUER)?.jwksUri).toBe(DOC.jwks_uri)

    // A document that turns out wrong does not replace the good one either.
    reply = { ...DOC, issuer: `${ISSUER}-other`, jwks_uri: 'https://evil.example.test/keys' }
    await expect(store.refresh(ISSUER)).rejects.toThrow(/document is for the issuer/)
    expect(store.current(ISSUER)?.jwksUri).toBe(DOC.jwks_uri)
  })
})
