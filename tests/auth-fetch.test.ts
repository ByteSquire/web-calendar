// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAuthClient, type OidcManagerLike, type OidcUserLike } from '../app/utils/auth/client'
import { AuthRequiredError } from '../app/utils/auth/errors'
import { createAuthFetch } from '../app/utils/auth/fetch'
import type { TokenProvider } from '../app/utils/auth/types'

const ORIGIN = 'https://calendar.example.org'

interface Seen {
  url: string
  method: string
  authorization: string | null
  headers: Headers
  body: string | null
}

/** A base fetch that records what it was given and answers from `reply` (default 200). */
function recorder(
  reply: (seen: Seen, call: number) => Response | Promise<Response> = () => new Response('ok'),
) {
  const seen: Seen[] = []
  const baseFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // a browser resolves a relative URL against the page
    const request = new Request(typeof input === 'string' ? new URL(input, ORIGIN) : input, init)
    const entry: Seen = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      headers: request.headers,
      body: request.body ? await request.text() : null,
    }
    seen.push(entry)
    return reply(entry, seen.length)
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  return { seen, baseFetch }
}

/** Tokens: `old` first, `new` after a renewal. */
function tokens() {
  let current = 'old'
  const getToken = vi.fn(async (options?: { rejectedToken?: string }) => {
    if (options?.rejectedToken === current) current = 'new'
    return current
  })
  return { getToken: getToken as TokenProvider & typeof getToken }
}

const unauthorizedWithOld = (seen: Seen) =>
  seen.authorization === 'Bearer old' ? new Response('no', { status: 401 }) : new Response('ok')

describe('the bearer token', () => {
  it.each([
    ['a relative path', '/api/me'],
    ['an absolute URL of the app', `${ORIGIN}/api/me`],
    ['a URL object', new URL(`${ORIGIN}/api/me`)],
    ['a path with a query', '/api/me?x=1'],
    ['the CalDAV gateway', '/caldav/abc/'],
  ])('is added to %s', async (_label, input) => {
    const { seen, baseFetch } = recorder()
    const { getToken } = tokens()
    const response = await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })(input)
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.authorization).toBe('Bearer old')
    expect(seen[0]!.url.startsWith(ORIGIN)).toBe(true)
  })

  it('keeps the method, body and the other headers of the call', async () => {
    const { seen, baseFetch } = recorder()
    const authFetch = createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })
    await authFetch('/api/things', {
      method: 'PUT',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json', 'X-Other': '1' },
    })
    expect(seen[0]).toMatchObject({ method: 'PUT', body: '{"a":1}', authorization: 'Bearer old' })
    expect(seen[0]!.headers.get('content-type')).toBe('application/json')
    expect(seen[0]!.headers.get('x-other')).toBe('1')
  })

  it('accepts headers as Headers or as pairs', async () => {
    const { seen, baseFetch } = recorder()
    const authFetch = createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })
    await authFetch('/api/a', { headers: new Headers({ 'X-One': '1' }) })
    await authFetch('/api/b', { headers: [['X-Two', '2']] })
    expect(seen[0]!.headers.get('x-one')).toBe('1')
    expect(seen[1]!.headers.get('x-two')).toBe('2')
    expect(seen.map((entry) => entry.authorization)).toEqual(['Bearer old', 'Bearer old'])
  })

  it('replaces a token the caller set', async () => {
    const { seen, baseFetch } = recorder()
    await createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })('/api/me', {
      headers: { Authorization: 'Bearer caller' },
    })
    expect(seen[0]!.authorization).toBe('Bearer old')
  })

  it('asks for the token of every request', async () => {
    const { baseFetch } = recorder()
    const { getToken } = tokens()
    const authFetch = createAuthFetch(getToken, baseFetch, { origin: ORIGIN })
    await authFetch('/api/a')
    await authFetch('/api/b')
    expect(getToken).toHaveBeenCalledTimes(2)
  })
})

describe('other origins get no token', () => {
  it.each([
    ['another host', 'https://other.example.net/api/me'],
    ['a host that starts like the app', 'https://calendar.example.org.evil.test/api/me'],
    ['a subdomain', 'https://sub.calendar.example.org/api/me'],
    ['a user-info trick', 'https://calendar.example.org@evil.test/api/me'],
    ['another scheme', 'http://calendar.example.org/api/me'],
    ['another port', 'https://calendar.example.org:8443/api/me'],
    ['a protocol-relative URL', '//evil.test/api/me'],
    ['a backslash trick', 'https://evil.test\\@calendar.example.org/api/me'],
    ['an external CalDAV server', 'https://dav.example.net/user/calendar/'],
  ])('%s', async (_label, url) => {
    // not the recorder: some of these URLs cannot be built into a Request, and are not meant to
    const baseFetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch
    const { getToken } = tokens()
    const authFetch = createAuthFetch(getToken, baseFetch, { origin: ORIGIN })
    await authFetch(url, { headers: { Authorization: 'Basic abc' } })
    expect(getToken).not.toHaveBeenCalled()
    expect(baseFetch).toHaveBeenCalledOnce()
    // passed through untouched: the same arguments, so the caller's own credentials still work
    expect(baseFetch).toHaveBeenCalledWith(url, { headers: { Authorization: 'Basic abc' } })
  })

  it('does not renew or retry a 401 from another origin', async () => {
    const { baseFetch } = recorder(() => new Response('no', { status: 401 }))
    const { getToken } = tokens()
    const response = await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })(
      'https://other.example.net/x',
    )
    expect(response.status).toBe(401)
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(getToken).not.toHaveBeenCalled()
  })

  it('does not send a token for a Request to another origin', async () => {
    const { seen, baseFetch } = recorder()
    const { getToken } = tokens()
    await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })(
      new Request('https://other.example.net/x'),
    )
    expect(seen[0]!.authorization).toBeNull()
    expect(getToken).not.toHaveBeenCalled()
  })

  it('sends no token when the app origin is unknown', async () => {
    const { seen, baseFetch } = recorder()
    const { getToken } = tokens()
    // no `location` in Node and no origin given: nothing can be called "the same origin"
    await createAuthFetch(getToken, baseFetch)(`${ORIGIN}/api/me`)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.authorization).toBeNull()
    expect(getToken).not.toHaveBeenCalled()
  })
})

describe('a 401', () => {
  it('renews the token and sends the request once more', async () => {
    const { seen, baseFetch } = recorder(unauthorizedWithOld)
    const { getToken } = tokens()
    const response = await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })('/api/me')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(seen.map((entry) => entry.authorization)).toEqual(['Bearer old', 'Bearer new'])
    expect(getToken).toHaveBeenNthCalledWith(1)
    expect(getToken).toHaveBeenNthCalledWith(2, { rejectedToken: 'old' })
  })

  it('returns a second 401 as it is, after exactly one retry', async () => {
    const { seen, baseFetch } = recorder(() => new Response('still no', { status: 401 }))
    const { getToken } = tokens()
    const response = await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })('/api/me')
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('still no')
    expect(seen).toHaveLength(2)
    expect(getToken).toHaveBeenCalledTimes(2)
  })

  it.each([[400], [403], [404], [409], [500], [503]])('does not renew for a %d', async (status) => {
    const { baseFetch } = recorder(() => new Response('x', { status }))
    const { getToken } = tokens()
    const response = await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })('/api/me')
    expect(response.status).toBe(status)
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(getToken).toHaveBeenCalledOnce()
  })

  it('does not retry when the token source gives up', async () => {
    const { baseFetch } = recorder(() => new Response('no', { status: 401 }))
    const getToken = vi.fn<TokenProvider>(async (options) => {
      if (options?.rejectedToken) throw new AuthRequiredError('renewal-failed')
      return 'old'
    })
    const authFetch = createAuthFetch(getToken, baseFetch, { origin: ORIGIN })
    await expect(authFetch('/api/me')).rejects.toBeInstanceOf(AuthRequiredError)
    expect(baseFetch).toHaveBeenCalledOnce()
  })

  it('sends no request when there is no token to send', async () => {
    const { baseFetch } = recorder()
    const getToken = vi.fn<TokenProvider>(async () => {
      throw new AuthRequiredError('signed-out')
    })
    await expect(
      createAuthFetch(getToken, baseFetch, { origin: ORIGIN })('/api/me'),
    ).rejects.toBeInstanceOf(AuthRequiredError)
    expect(baseFetch).not.toHaveBeenCalled()
  })

  it('passes a network error of the request on without retrying', async () => {
    const baseFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const { getToken } = tokens()
    await expect(
      createAuthFetch(getToken, baseFetch, { origin: ORIGIN })('/api/me'),
    ).rejects.toThrow('Failed to fetch')
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(getToken).toHaveBeenCalledOnce()
  })

  describe('bodies', () => {
    const replayable: Array<[string, () => BodyInit]> = [
      ['a string', () => '{"a":1}'],
      ['URLSearchParams', () => new URLSearchParams({ a: '1' })],
      ['a Blob', () => new Blob(['abc'])],
      ['an ArrayBuffer', () => new TextEncoder().encode('abc').buffer as ArrayBuffer],
      ['a Uint8Array', () => new TextEncoder().encode('abc')],
      [
        'FormData',
        () => {
          const form = new FormData()
          form.set('a', '1')
          return form
        },
      ],
    ]

    it.each(replayable)('%s is sent again', async (_label, makeBody) => {
      const { seen, baseFetch } = recorder(unauthorizedWithOld)
      const authFetch = createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })
      const response = await authFetch('/api/things', { method: 'POST', body: makeBody() })
      expect(response.status).toBe(200)
      expect(seen).toHaveLength(2)
      expect(seen[1]!.authorization).toBe('Bearer new')
      expect(seen[1]!.method).toBe('POST')
      // the same bytes the second time (a multipart boundary is chosen anew for each request)
      const unboundary = (text: string | null) => text?.replace(/-+formdata-[\w-]+/g, '--B')
      expect(unboundary(seen[1]!.body)).toBe(unboundary(seen[0]!.body))
      expect(seen[1]!.body).not.toBe('')
    })

    it('a stream is not sent again: the first attempt consumed it', async () => {
      const { seen, baseFetch } = recorder(() => new Response('no', { status: 401 }))
      const { getToken } = tokens()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk'))
          controller.close()
        },
      })
      const response = await createAuthFetch(getToken, baseFetch, { origin: ORIGIN })('/api/up', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit)
      expect(response.status).toBe(401)
      expect(seen).toHaveLength(1)
      expect(getToken).toHaveBeenCalledOnce()
    })
  })

  describe('with a Request as input', () => {
    it('adds the token to a copy and leaves the request alone', async () => {
      const { seen, baseFetch } = recorder()
      const request = new Request(`${ORIGIN}/api/things`, {
        method: 'POST',
        body: 'payload',
        headers: { 'Content-Type': 'text/plain', 'X-Keep': 'yes' },
      })
      await createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })(request)
      expect(seen[0]).toMatchObject({
        method: 'POST',
        body: 'payload',
        authorization: 'Bearer old',
      })
      expect(seen[0]!.headers.get('x-keep')).toBe('yes')
      expect(seen[0]!.headers.get('content-type')).toBe('text/plain')
      expect(request.headers.get('authorization')).toBeNull()
      expect(request.bodyUsed).toBe(false)
    })

    it('sends the body again on the retry', async () => {
      const { seen, baseFetch } = recorder(unauthorizedWithOld)
      const request = new Request(`${ORIGIN}/api/things`, { method: 'PUT', body: 'payload' })
      const response = await createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })(
        request,
      )
      expect(response.status).toBe(200)
      expect(seen.map((entry) => [entry.authorization, entry.body, entry.method])).toEqual([
        ['Bearer old', 'payload', 'PUT'],
        ['Bearer new', 'payload', 'PUT'],
      ])
    })

    it('accepts a Request without a body and a relative-looking one', async () => {
      const { seen, baseFetch } = recorder(unauthorizedWithOld)
      await createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })(
        new Request(`${ORIGIN}/api/me`),
      )
      expect(seen.map((entry) => entry.authorization)).toEqual(['Bearer old', 'Bearer new'])
    })

    it('takes the headers of init over those of the request, as fetch does', async () => {
      const { seen, baseFetch } = recorder()
      const request = new Request(`${ORIGIN}/api/me`, { headers: { 'X-From-Request': '1' } })
      await createAuthFetch(tokens().getToken, baseFetch, { origin: ORIGIN })(request, {
        headers: { 'X-From-Init': '1' },
      })
      expect(seen[0]!.headers.get('x-from-init')).toBe('1')
      expect(seen[0]!.headers.get('x-from-request')).toBeNull()
      expect(seen[0]!.authorization).toBe('Bearer old')
    })
  })
})

describe('with the real client and a fake provider', () => {
  function world(options: { expiresIn?: number } = {}) {
    let stored: OidcUserLike | null = {
      access_token: 'old',
      expires_at: Date.now() / 1000 + (options.expiresIn ?? 900),
      profile: { sub: 's1' },
    }
    const signinSilent = vi.fn(async () => {
      // the provider takes a moment, like a network round trip
      await new Promise((resolve) => setTimeout(resolve, 10))
      stored = { access_token: 'new', expires_at: Date.now() / 1000 + 900, profile: { sub: 's1' } }
      return stored
    })
    const manager = {
      getUser: async () => stored,
      removeUser: async () => {
        stored = null
      },
      signinRedirect: async () => undefined,
      signinRedirectCallback: async () => stored!,
      signinSilent,
      signoutRedirect: async () => undefined,
      revokeTokens: async () => undefined,
      metadataService: {
        getEndSessionEndpoint: async () => undefined,
        getRevocationEndpoint: async () => undefined,
      },
    } satisfies OidcManagerLike
    const client = createAuthClient({
      issuer: 'https://idm.example.org/oauth2/openid/web-calendar',
      clientId: 'web-calendar',
      scope: 'openid',
      origin: ORIGIN,
      createUserManager: () => manager,
    })
    return { client, signinSilent }
  }

  it('renews once when many requests are refused at the same time', async () => {
    const { client, signinSilent } = world()
    const { seen, baseFetch } = recorder(unauthorizedWithOld)
    const authFetch = createAuthFetch(client.getAccessToken, baseFetch, { origin: ORIGIN })
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => authFetch(`/api/item/${index}`)),
    )
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200))
    expect(signinSilent).toHaveBeenCalledOnce()
    expect(seen.filter((entry) => entry.authorization === 'Bearer old')).toHaveLength(6)
    expect(seen.filter((entry) => entry.authorization === 'Bearer new')).toHaveLength(6)
  })

  it('renews once when many requests find the token about to expire', async () => {
    const { client, signinSilent } = world({ expiresIn: 20 })
    const { seen, baseFetch } = recorder()
    const authFetch = createAuthFetch(client.getAccessToken, baseFetch, { origin: ORIGIN })
    await Promise.all(Array.from({ length: 6 }, (_, index) => authFetch(`/api/item/${index}`)))
    expect(signinSilent).toHaveBeenCalledOnce()
    expect(new Set(seen.map((entry) => entry.authorization))).toEqual(new Set(['Bearer new']))
  })
})
