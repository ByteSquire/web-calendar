// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DavError, type DavErrorKind } from '../app/utils/caldav/errors'
import {
  accountOrigin,
  createProxyFetch,
  proxyUrl,
  resolveAccountUrl,
} from '../app/utils/external/proxy-fetch'
import { HOST, SEALED, account, fakeProxy, multistatus, own, ownError } from './external-helpers'

// The `fetch` of one external account: what it rewrites, what it refuses, and how the answers of
// the proxy become typed errors. The credential belongs to ONE origin, so most of this file is
// about the requests that must not leave.

const OK = () => multistatus()

function setup(options: { authMode?: 'none' | 'basic'; sealed?: string | null } = {}) {
  const proxy = fakeProxy(OK)
  const onCredentialVoid = vi.fn()
  const sealed = options.sealed === undefined ? SEALED : options.sealed
  const fetchFn = createProxyFetch({
    account: account(5, { url: `${HOST}/dav/`, authMode: options.authMode ?? 'none' }),
    fetch: proxy.fetch,
    sealed: () => sealed,
    onCredentialVoid,
  })
  return { ...proxy, fetch: fetchFn, onCredentialVoid }
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

describe('rewriting', () => {
  it('sends a URL of the account’s origin to /api/external/<id> with path and query', async () => {
    const { fetch, calls } = setup()
    await fetch(`${HOST}/dav/calendars/work/?x=1&y=%20z`, { method: 'REPORT', body: '<x/>' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/external/5/dav/calendars/work/?x=1&y=%20z')
    expect(calls[0]!.method).toBe('REPORT')
    expect(calls[0]!.body).toBe('<x/>')
  })

  it('accepts a URL object and keeps the headers of the caller', async () => {
    const { fetch, calls } = setup()
    await fetch(new URL(`${HOST}/dav/`), {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'text/xml' },
    })
    expect(calls[0]!.headers.get('depth')).toBe('1')
    expect(calls[0]!.headers.get('content-type')).toBe('text/xml')
  })

  it('reads a path against the account’s address', async () => {
    const { fetch, calls } = setup()
    await fetch('/dav/calendars/work/', { method: 'PROPFIND' })
    expect(calls[0]!.url).toBe('/api/external/5/dav/calendars/work/')
  })

  it('treats the default port, the case of the host and dot segments as what they are', async () => {
    const { fetch, calls } = setup()
    await fetch('https://DAV.example.org:443/dav/a/../b/', { method: 'GET' })
    await fetch('https://dav.example.org/dav/%2e%2e/c/', { method: 'GET' })
    expect(calls.map((call) => call.url)).toEqual(['/api/external/5/dav/b/', '/api/external/5/c/'])
  })

  it('keeps an encoded slash or backslash in the path as it is', async () => {
    const { fetch, calls } = setup()
    await fetch(`${HOST}/dav/%2F%2Fevil.example/x%5Cy`, { method: 'GET' })
    expect(calls[0]!.url).toBe('/api/external/5/dav/%2F%2Fevil.example/x%5Cy')
  })

  it('keeps a double slash inside the path (it is the account’s own path)', async () => {
    const { fetch, calls } = setup()
    await fetch(`${HOST}//evil.example/x`, { method: 'GET' })
    expect(calls[0]!.url).toBe('/api/external/5//evil.example/x')
    expect(calls[0]!.url.startsWith('/api/external/5/')).toBe(true)
  })

  it('defaults to GET and upper-cases the method', async () => {
    const { fetch, calls } = setup()
    await fetch(`${HOST}/a`)
    await fetch(`${HOST}/b`, { method: 'propfind' })
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PROPFIND'])
  })

  it('names the proxy path of a URL', () => {
    expect(proxyUrl(12, new URL(`${HOST}/a/b?c=d#e`))).toBe('/api/external/12/a/b?c=d')
  })
})

describe('the origin refusal', () => {
  // Every one of these must throw before anything is sent, and nothing may fall back to a
  // request of the page's own.
  const hostile: [string, string][] = [
    ['another host', 'https://evil.example/dav/'],
    ['a look-alike with the account’s host in the path', 'https://evil.example/@dav.example.org'],
    ['a look-alike with the account’s host as user info', 'https://dav.example.org@evil.example/'],
    ['a look-alike with the account’s host as a prefix', 'https://dav.example.org.evil.example/'],
    ['a look-alike with the account’s host as a suffix', 'https://evildav.example.org/'],
    ['a look-alike with a different TLD', 'https://dav.example.org.attacker.test/'],
    ['user info on the account’s host', 'https://user@dav.example.org/dav/'],
    ['user info with a password', 'https://user:secret@dav.example.org/dav/'],
    ['an empty user name with a password', 'https://:secret@dav.example.org/dav/'],
    ['another port', 'https://dav.example.org:8443/dav/'],
    ['the other scheme', 'http://dav.example.org/dav/'],
    ['a scheme-relative URL', '//evil.example/dav/'],
    ['a scheme-relative URL with the account’s host in it', '//evil.example/dav.example.org'],
    ['backslashes that browsers read as slashes', '/\\evil.example/dav/'],
    ['backslashes after the scheme', 'https:\\\\evil.example\\dav\\'],
    ['a tab inside the host', 'https://dav.example.org\t.evil.example/'],
    ['a newline inside the host', 'https://dav.example.org\n.evil.example/'],
    ['a trailing dot on the host', 'https://dav.example.org./dav/'],
    ['an IP address', 'https://127.0.0.1/dav/'],
    ['the app’s own origin as an absolute URL', 'https://calendar.example.org/api/me'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/plain,hi'],
    ['a file: URL', 'file:///etc/passwd'],
    ['an ftp: URL', 'ftp://dav.example.org/dav/'],
    ['a ws: URL', 'wss://dav.example.org/dav/'],
    ['a blob: URL', 'blob:https://dav.example.org/uuid'],
    ['an encoded dot in the host', 'https://dav%2eexample%2eorg.evil.example/'],
    ['a full-width dot that normalises to another host', 'https://dav.example.org。evil.example/'],
  ]

  it.each(hostile)('refuses %s', async (_name, url) => {
    const { fetch, calls } = setup({ authMode: 'basic' })
    expect(await kindOf(fetch(url, { method: 'PROPFIND' }))).toBe('bad-response')
    expect(calls).toEqual([])
  })

  it('refuses a Request object, which could carry anything', async () => {
    const { fetch, calls } = setup()
    await expect(fetch(new Request(`${HOST}/dav/`))).rejects.toBeInstanceOf(TypeError)
    expect(calls).toEqual([])
  })

  it('never calls the global fetch', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const { fetch } = setup()
    await fetch(`${HOST}/dav/`, { method: 'PROPFIND' })
    await kindOf(fetch('https://evil.example/', { method: 'PROPFIND' }))
    expect(globalFetch).not.toHaveBeenCalled()
    globalFetch.mockRestore()
  })

  it('pins the origin when the adapter is made: an address without one is no account', () => {
    const make = (url: string) =>
      createProxyFetch({
        account: account(1, { url }),
        fetch: fakeProxy(OK).fetch,
        sealed: () => null,
      })
    expect(() => make('not a url')).toThrow(TypeError)
    expect(() => make('ftp://dav.example.org/')).toThrow(TypeError)
    expect(() => make('mailto:me@example.org')).toThrow(TypeError)
    expect(accountOrigin('https://dav.example.org:443/x')).toBe('https://dav.example.org')
    expect(accountOrigin('http://dav.example.org:8080/x')).toBe('http://dav.example.org:8080')
  })

  it('checks every request, not only the first', async () => {
    const { fetch, calls } = setup()
    await fetch(`${HOST}/ok`, { method: 'GET' })
    expect(await kindOf(fetch('https://evil.example/', { method: 'GET' }))).toBe('bad-response')
    await fetch(`${HOST}/ok-again`, { method: 'GET' })
    expect(calls.map((call) => call.target)).toEqual(['/ok', '/ok-again'])
  })

  it('resolveAccountUrl returns the URL it checked, and only that', () => {
    expect(resolveAccountUrl(`${HOST}/dav/`, '/a?b=1').href).toBe(`${HOST}/a?b=1`)
    expect(() => resolveAccountUrl(`${HOST}/dav/`, 'http://[::1')).toThrow(DavError)
  })
})

describe('methods', () => {
  it.each(['PROPFIND', 'REPORT', 'GET', 'HEAD', 'OPTIONS'])('lets %s through', async (method) => {
    const { fetch, calls } = setup()
    await fetch(`${HOST}/dav/`, { method })
    expect(calls.map((call) => call.method)).toEqual([method])
  })

  it.each(['PUT', 'DELETE', 'MKCALENDAR', 'PROPPATCH', 'POST', 'COPY', 'MOVE', 'MKCOL', 'PATCH'])(
    'refuses %s: external calendars are read-only',
    async (method) => {
      const { fetch, calls } = setup()
      expect(await kindOf(fetch(`${HOST}/dav/x.ics`, { method, body: 'x' }))).toBe('forbidden')
      expect(calls).toEqual([])
    },
  )
})

describe('the credential', () => {
  it('sends the sealed credential of an account with a login, and only the sealed one', async () => {
    const { fetch, calls } = setup({ authMode: 'basic' })
    await fetch(`${HOST}/dav/`, { method: 'PROPFIND' })
    expect(calls[0]!.headers.get('x-upstream-authorization')).toBe(`Sealed ${SEALED}`)
  })

  it('sends none for an account without a login', async () => {
    const { fetch, calls } = setup({ authMode: 'none' })
    await fetch(`${HOST}/dav/`, { method: 'PROPFIND' })
    expect(calls[0]!.headers.has('x-upstream-authorization')).toBe(false)
  })

  it('drops an Authorization or credential header the caller set', async () => {
    const { fetch, calls } = setup({ authMode: 'none' })
    await fetch(`${HOST}/dav/`, {
      method: 'PROPFIND',
      headers: { Authorization: 'Basic c2VjcmV0', 'X-Upstream-Authorization': 'Sealed other' },
    })
    expect(calls[0]!.headers.has('authorization')).toBe(false)
    expect(calls[0]!.headers.has('x-upstream-authorization')).toBe(false)

    const withLogin = setup({ authMode: 'basic' })
    await withLogin.fetch(`${HOST}/dav/`, {
      method: 'PROPFIND',
      headers: { 'X-Upstream-Authorization': 'Sealed other' },
    })
    expect(withLogin.calls[0]!.headers.get('x-upstream-authorization')).toBe(`Sealed ${SEALED}`)
  })

  it('asks for a password at once, without a request, when the browser has none', async () => {
    const { fetch, calls } = setup({ authMode: 'basic', sealed: null })
    expect(await kindOf(fetch(`${HOST}/dav/`, { method: 'PROPFIND' }))).toBe('credential-needed')
    expect(calls).toEqual([])
  })
})

describe('the answers of the proxy', () => {
  async function kindFor(answer: () => Response, authMode: 'none' | 'basic' = 'basic') {
    const proxy = fakeProxy(answer)
    const voided = vi.fn()
    const fetchFn = createProxyFetch({
      account: account(5, { authMode }),
      fetch: proxy.fetch,
      sealed: () => SEALED,
      onCredentialVoid: voided,
    })
    return { kind: await kindOf(fetchFn(`${HOST}/dav/`, { method: 'PROPFIND' })), voided }
  }

  it('hands on what the account’s server answered', async () => {
    const proxy = fakeProxy(() => multistatus())
    const response = await createProxyFetch({
      account: account(5),
      fetch: proxy.fetch,
      sealed: () => null,
    })(`${HOST}/dav/`, { method: 'PROPFIND' })
    expect(response.status).toBe(207)
    expect(response.headers.get('x-upstream-status')).toBe('207')
  })

  // Statuses the account’s server itself answers with come back as they are: the CalDAV client
  // words them (404 as not found, 5xx as unavailable ...).
  it.each([403, 404, 405, 409, 412, 429, 500, 503])(
    'hands on the account’s own %i, which carries X-Upstream-Status',
    async (status) => {
      const proxy = fakeProxy(() => new Response('nope', { status }))
      const response = await createProxyFetch({
        account: account(5),
        fetch: proxy.fetch,
        sealed: () => null,
      })(`${HOST}/dav/`, { method: 'PROPFIND' })
      expect(response.status).toBe(status)
      expect(response.headers.get('x-upstream-status')).toBe(String(status))
    },
  )

  it('turns the account’s 401 (a 502 with X-Upstream-Status: 401) into login-rejected', async () => {
    const { kind, voided } = await kindFor(() => new Response('', { status: 401 }))
    expect(kind).toBe('login-rejected')
    expect(voided).not.toHaveBeenCalled()
  })

  it('also reads a bare upstream_login_failed 502 with the header as login-rejected', async () => {
    const answer = () =>
      new Response(JSON.stringify({ error: 'upstream_login_failed' }), {
        status: 502,
        headers: {
          'content-type': 'application/json',
          'x-upstream-status': '401',
          'x-proxy-own': '1',
        },
      })
    expect((await kindFor(answer)).kind).toBe('login-rejected')
  })

  it('turns 428 into credential-needed and tells that the seal is void', async () => {
    const { kind, voided } = await kindFor(ownError.credentialRequired)
    expect(kind).toBe('credential-needed')
    expect(voided).toHaveBeenCalledTimes(1)
  })

  it('turns 403 host_not_allowed (no X-Upstream-Status) into host-not-allowed', async () => {
    expect((await kindFor(ownError.hostNotAllowed)).kind).toBe('host-not-allowed')
  })

  it('turns 429 rate_limited into rate-limited', async () => {
    expect((await kindFor(ownError.rateLimited)).kind).toBe('rate-limited')
  })

  it('turns 404 account_not_found into not-found', async () => {
    expect((await kindFor(ownError.accountNotFound)).kind).toBe('not-found')
  })

  it.each([
    ['unreachable', 'network'],
    ['timeout', 'network'],
    ['redirectRefused', 'network'],
    ['tooLarge', 'bad-response'],
  ] as const)('turns the 502 %s into %s', async (failure, expected) => {
    expect((await kindFor(ownError[failure])).kind).toBe(expected)
  })

  it('turns the 401 of the proxy route into unauthorized: it is the app’s own token', async () => {
    const { kind, voided } = await kindFor(ownError.appToken)
    expect(kind).toBe('unauthorized')
    expect(voided).not.toHaveBeenCalled()
  })

  it('reads the code from the project’s usual error body too', async () => {
    const answer = (status: number, data: unknown) => () =>
      own(
        new Response(
          JSON.stringify({ error: true, statusCode: status, statusMessage: 'Error', data }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
      )
    expect((await kindFor(answer(403, { code: 'host_not_allowed' }))).kind).toBe('host-not-allowed')
    expect((await kindFor(answer(429, { reason: 'rate_limited' }))).kind).toBe('rate-limited')
    expect((await kindFor(answer(428, { code: 'credential_required' }))).kind).toBe(
      'credential-needed',
    )
  })

  it('decides by status when the body says nothing useful', async () => {
    const plain = (status: number) => () =>
      own(new Response('<html>oops</html>', { status, headers: { 'content-type': 'text/html' } }))
    expect((await kindFor(plain(428))).kind).toBe('credential-needed')
    expect((await kindFor(plain(403))).kind).toBe('host-not-allowed')
    expect((await kindFor(plain(429))).kind).toBe('rate-limited')
    expect((await kindFor(plain(502))).kind).toBe('network')
    expect((await kindFor(plain(504))).kind).toBe('network')
    expect((await kindFor(plain(500))).kind).toBe('unavailable')
    expect((await kindFor(plain(400))).kind).toBe('rejected')
  })

  it('does not take a code from the body of the account’s own answer', async () => {
    // The account’s server answers 403 and says "host_not_allowed" in its own JSON: that is its
    // text, not the proxy’s verdict.
    const proxy = fakeProxy(
      () =>
        new Response(JSON.stringify({ error: 'host_not_allowed' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const response = await createProxyFetch({
      account: account(5),
      fetch: proxy.fetch,
      sealed: () => null,
    })(`${HOST}/dav/`, { method: 'PROPFIND' })
    expect(response.status).toBe(403)
  })

  it('lets the abort of the caller through as it is', async () => {
    const controller = new AbortController()
    const fetchFn = createProxyFetch({
      account: account(5),
      fetch: ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })) as typeof fetch,
      sealed: () => null,
    })
    const pending = fetchFn(`${HOST}/dav/`, { method: 'PROPFIND', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
