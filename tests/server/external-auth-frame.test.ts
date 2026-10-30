// @vitest-environment node
// The frame around the external-account routes is the usual one: a bearer token, nothing else. In
// particular an app token over HTTP Basic (what third-party CalDAV clients use at /caldav/) is not a
// way into the proxy or the account API: the proxy would otherwise be reachable by any client that
// holds an app token, and a 401 from these routes must always mean "the app's bearer token is bad".
// This runs the real `requireUser` (no stand-in), with a runtime config like Nitro would give it.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as h3 from 'h3'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { authenticateRequest } from '../../server/utils/auth/authenticate'
import { AuthError } from '../../server/utils/auth/errors'

const config = vi.hoisted(() => ({ current: {} as unknown }))

vi.mock('#app/nuxt', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRuntimeConfig: () => config.current,
}))

let server: Server
let base = ''

beforeAll(async () => {
  // `server/utils/auth/nitro.ts` uses h3's helpers as Nitro auto-imports, which Vitest does not give.
  for (const name of ['appendResponseHeader', 'setResponseHeader', 'createError'] as const) {
    vi.stubGlobal(name, h3[name])
  }
  config.current = {
    oidc: {
      issuer: 'https://idm.example.org/oauth2/openid/web-calendar',
      clientId: 'web-calendar',
      allowedClients: '',
      scope: 'openid',
      requiredScope: 'caldav',
      adminGroup: 'calendar_admins',
      keyMaxAgeSec: '3600',
    },
    tokenHashKey: 'k'.repeat(32),
    radicale: { url: 'http://radicale:5232' },
    icalProxy: {
      cacheTtlSec: '300',
      maxBytes: '5242880',
      timeoutMs: '10000',
      allowPrivate: 'false',
    },
    outbound: { allowedHosts: '' },
    external: { sealKey: '' },
  }
  const proxy = (await import('../../server/api/external/[id]/[...path]')).default
  const list = (await import('../../server/api/external-accounts/index.get')).default
  const create = (await import('../../server/api/external-accounts/index.post')).default
  const router = createRouter({ preemptive: true })
  router.use('/api/external/:id/**', proxy)
  router.use('/api/external/:id', proxy)
  router.get('/api/external-accounts', list)
  router.post('/api/external-accounts', create)
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
})

const basic = (user: string, token: string) =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`

describe('an app token over HTTP Basic', () => {
  const TOKEN = 'wcal_' + 'a'.repeat(43)

  it.each([
    ['PROPFIND', '/api/external/1/dav/'],
    ['GET', '/api/external/1/dav/calendars/alice/work/standup.ics'],
    ['REPORT', '/api/external/1/'],
    ['GET', '/api/external-accounts'],
    ['POST', '/api/external-accounts'],
  ])('is refused with 401 and only a Bearer challenge: %s %s', async (method, path) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: basic('alice', TOKEN), 'x-upstream-authorization': 'Sealed abc' },
      body: method === 'POST' ? '{}' : undefined,
    })
    expect(response.status).toBe(401)
    const challenges = response.headers.get('www-authenticate') ?? ''
    expect(challenges).toContain('Bearer')
    expect(challenges).not.toContain('Basic')
  })

  it('is refused by authenticateRequest as configured for /api/**: no app-token lookup is given', async () => {
    const verifier = { verify: vi.fn() }
    const error = await authenticateRequest(new Headers({ authorization: basic('alice', TOKEN) }), {
      verifier,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ reason: 'unsupported-scheme', status: 401 })
    expect((error as AuthError).challenges).toEqual(['Bearer realm="Web Calendar"'])
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  it('a missing, malformed or garbage token is a 401 as well', async () => {
    for (const authorization of [undefined, '', 'Bearer', 'Bearer not-a-jwt', 'Token abc']) {
      const response = await fetch(`${base}/api/external/1/dav/`, {
        method: 'GET',
        headers: authorization === undefined ? {} : { authorization },
      })
      expect([authorization, response.status]).toEqual([authorization, 401])
    }
  })
})
