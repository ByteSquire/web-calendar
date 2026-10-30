// @vitest-environment node
// The HTTP contract of the external-account feature: the real route files and the real middleware
// behind an h3 app on a real socket, an in-memory database, the real glue modules with a runtime
// config like Nitro would give them, a stand-in for token verification (`Bearer test-<name>` is
// the user `sub-<name>`) and a fake CalDAV server on loopback as the account's server.
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import {
  createApp,
  createRouter,
  defineEventHandler,
  toNodeListener,
  type H3Event,
  type RouterMethod,
  type EventHandler,
} from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTERNAL_CREDENTIAL_HEADER, type ExternalAccountResult } from '../../shared/types/external'
import { API_MAX_BODY_BYTES } from '../../server/utils/api/body-limit'
import { setDb } from '../../server/utils/db'
import { createSealer, parseSealKey } from '../../server/utils/external/seal'
import { RESOURCE_CSP } from '../../server/utils/security/headers'
import apiGuards from '../../server/middleware/api-guards'
import {
  FAKE_CALDAV_PATHS as PATHS,
  startFakeCalDav,
  type FakeCalDav,
} from '../helpers/fake-caldav'
import { openTestDb } from './api-fixtures'

const config = vi.hoisted(() => ({ current: {} as unknown }))

// The glue files use Nitro's auto-imported `useRuntimeConfig`; under Vitest Nuxt's transform
// resolves that name to the Vue app's composable, so this stands in for it.
vi.mock('#app/nuxt', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRuntimeConfig: () => config.current,
}))

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  return {
    requireUser: async (event: H3Event) => {
      const match = /^Bearer test-(\S+)$/.exec(event.headers.get('authorization') ?? '')
      if (!match) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
      return { sub: `sub-${match[1]}`, via: 'bearer' as const }
    },
  }
})

const SEAL_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 5)).toString('base64')
const sealer = createSealer(parseSealKey(SEAL_KEY))

const API_DIR = fileURLToPath(new URL('../../server/api', import.meta.url))

/** Nitro's file-based routing for `server/api`, as far as this project uses it. */
function routeFiles(): { file: string; route: string; method?: RouterMethod }[] {
  const list = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? list(join(dir, entry.name)) : [join(dir, entry.name)],
    )
  return list(API_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => {
      const parts = relative(API_DIR, file).replace(/\.ts$/, '').split('/')
      const last = /^(.*?)(?:\.(get|post|put|patch|delete|head|options))?$/.exec(parts.pop()!)!
      const segments = [...parts, last[1]!]
        .filter((segment) => segment !== 'index')
        .map((segment) =>
          segment.replace(/^\[\.\.\.(\w+)\]$/, '**:$1').replace(/^\[(.+)\]$/, ':$1'),
        )
      return {
        file,
        route: `/api/${segments.join('/')}`.replace(/\/$/, ''),
        method: last[2] as RouterMethod | undefined,
      }
    })
}

let db: Database
let server: Server
/** The headers of every request as the app received them (to show a test really sent them). */
const received: Record<string, string>[] = []
const lastReceived = () => received.at(-1)!
let base = ''
let fake: FakeCalDav
let victim: FakeCalDav
const LOGIN = { username: 'alice', password: 'pw-alice' }

beforeAll(async () => {
  config.current = {
    oidc: { issuer: 'https://idm.example.org/oauth2/openid/web-calendar' },
    radicale: { url: 'http://radicale:5232' },
    icalProxy: {
      cacheTtlSec: '300',
      maxBytes: '5242880',
      timeoutMs: '10000',
      allowPrivate: 'true',
    },
    outbound: { allowedHosts: '' },
    external: { sealKey: SEAL_KEY },
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  db = openTestDb()
  setDb(db)

  // The routes are imported only now, after the runtime config exists.
  const router = createRouter({ preemptive: true })
  for (const { file, route, method } of routeFiles()) {
    if (!route.startsWith('/api/external')) continue
    const handler = ((await import(/* @vite-ignore */ file)) as { default: EventHandler }).default
    router.use(route, handler, method)
  }
  const app = createApp()
  app.use(defineEventHandler((event) => void received.push(Object.fromEntries(event.headers))))
  app.use(apiGuards)
  app.use(router.handler)
  server = createServer(toNodeListener(app))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  fake = await startFakeCalDav({ host: '127.0.0.1' })
  victim = await startFakeCalDav({ host: '127.0.0.2' })
})

afterAll(async () => {
  vi.restoreAllMocks()
  db.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await fake.close()
  await victim.close()
})

beforeEach(() => {
  // One database for the file: the limiter of the proxy is keyed by user id and lives as long as
  // the glue module, so ids must not restart from 1 in every test.
  db.prepare('DELETE FROM external_accounts').run()
  fake.clear()
  fake.setLogin(undefined)
  fake.setCrossOriginTarget(victim.url(PATHS.home))
  victim.clear()
})

interface Reply {
  status: number
  headers: Headers
  text: string
  json: () => any // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper: bodies are checked by shape
}

async function call(
  user: string | null,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Reply> {
  const headers = new Headers(options.headers)
  if (user) headers.set('authorization', `Bearer test-${user}`)
  let body: string | undefined
  if (options.raw !== undefined) body = options.raw
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(`${base}${path}`, { method, headers, body })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) }
}

/** A request whose target is sent exactly as written (`fetch` would clean up `..` and `//`). */
function raw(
  user: string,
  method: string,
  target: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}`,
      {
        method,
        path: target,
        headers: { authorization: `Bearer test-${user}`, ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of [value].flat()) if (item !== undefined) headers.append(name, item)
          }
          resolve({ status: response.statusCode ?? 0, headers, text, json: () => JSON.parse(text) })
        })
      },
    )
    request.on('error', reject)
    request.end(options.body)
  })
}

async function addAccount(
  user: string,
  body: Record<string, unknown>,
): Promise<ExternalAccountResult> {
  const reply = await call(user, 'POST', '/api/external-accounts', { body })
  expect([reply.status, reply.text]).toEqual([201, reply.text])
  return reply.json()
}

const home = () => fake.url(PATHS.home)
const proxy = (id: number, path: string) => `/api/external/${id}${path}`
const sealed = (value: string) => ({ [EXTERNAL_CREDENTIAL_HEADER]: `Sealed ${value}` })

describe('the account API', () => {
  it('needs a token on every route', async () => {
    for (const [method, path] of [
      ['GET', '/api/external-accounts'],
      ['POST', '/api/external-accounts'],
      ['PUT', '/api/external-accounts/1'],
      ['DELETE', '/api/external-accounts/1'],
      ['POST', '/api/external-accounts/1/credential'],
      ['GET', '/api/external/1/dav/'],
      ['PROPFIND', '/api/external/1/dav/'],
    ] as const) {
      const reply = await call(null, method, path)
      expect([method, path, reply.status]).toEqual([method, path, 401])
    }
  })

  it('lists, creates (201), changes, reseals and deletes (204)', async () => {
    const empty = await call('amy', 'GET', '/api/external-accounts')
    expect([empty.status, empty.json()]).toEqual([200, { accounts: [], loginsEnabled: true }])

    const created = await call('amy', 'POST', '/api/external-accounts', {
      body: {
        name: 'Work',
        url: home(),
        authMode: 'basic',
        username: 'alice',
        password: 'pw-alice',
      },
    })
    expect(created.status).toBe(201)
    const { account, sealed: seal } = created.json() as ExternalAccountResult
    expect(account).toMatchObject({
      name: 'Work',
      url: home(),
      authMode: 'basic',
      username: 'alice',
    })
    expect(seal).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(created.headers.get('cache-control')).toBe('no-store')
    expect(created.text).not.toContain('pw-alice')

    const listed = (await call('amy', 'GET', '/api/external-accounts')).json()
    expect(listed.accounts).toEqual([account])
    expect(JSON.stringify(listed)).not.toContain('"sealed"')

    const renamed = await call('amy', 'PUT', `/api/external-accounts/${account.id}`, {
      body: { name: 'Renamed' },
    })
    expect([renamed.status, renamed.json().account.name, renamed.json().sealed]).toEqual([
      200,
      'Renamed',
      null,
    ])

    const resealed = await call('amy', 'POST', `/api/external-accounts/${account.id}/credential`, {
      body: { password: 'new-device' },
    })
    expect(resealed.status).toBe(200)
    expect(resealed.json().account.id).toBe(account.id)
    expect(
      sealer.open(resealed.json().sealed, {
        sub: 'sub-amy',
        accountId: account.id,
        origin: fake.origin,
      }),
    ).toEqual({ username: 'alice', password: 'new-device' })

    const removed = await call('amy', 'DELETE', `/api/external-accounts/${account.id}`)
    expect([removed.status, removed.text]).toEqual([204, ''])
    expect((await call('amy', 'GET', '/api/external-accounts')).json().accounts).toEqual([])
  })

  it('answers 400 with the usual fields, and the code for an address', async () => {
    const reply = await call('amy', 'POST', '/api/external-accounts', {
      body: { name: '', url: 'ftp://x', authMode: 'none' },
    })
    expect(reply.status).toBe(400)
    expect(reply.json()).toMatchObject({
      statusCode: 400,
      data: {
        code: 'invalid_url',
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'name' }),
          expect.objectContaining({ field: 'url' }),
        ]),
      },
    })
    const none = await call('amy', 'POST', '/api/external-accounts', { body: { url: home() } })
    expect(none.status).toBe(400)
    expect(none.json().data.code).toBeUndefined()
  })

  it('answers 400 credential_required when a change needs the password, and 409 for duplicates', async () => {
    const { account } = await addAccount('amy', {
      name: 'W',
      url: home(),
      authMode: 'basic',
      username: 'alice',
      password: 'pw',
    })
    const noPassword = await call('amy', 'PUT', `/api/external-accounts/${account.id}`, {
      body: { url: victim.url(PATHS.home) },
    })
    expect([noPassword.status, noPassword.json().data.code]).toEqual([400, 'credential_required'])
    const duplicate = await call('amy', 'POST', '/api/external-accounts', {
      body: { name: 'Again', url: home(), authMode: 'none' },
    })
    expect([duplicate.status, duplicate.json().data.code]).toEqual([409, 'duplicate'])
  })

  it('answers 404 for another user’s account on change, reseal and delete', async () => {
    const { account } = await addAccount('amy', {
      name: 'W',
      url: home(),
      authMode: 'basic',
      username: 'alice',
      password: 'pw',
    })
    const id = account.id
    for (const [method, path, body] of [
      ['PUT', `/api/external-accounts/${id}`, { name: 'x' }],
      ['POST', `/api/external-accounts/${id}/credential`, { password: 'x' }],
      ['DELETE', `/api/external-accounts/${id}`, undefined],
    ] as const) {
      const reply = await call('ben', method, path, { body })
      expect([method, reply.status]).toEqual([method, 404])
    }
    expect((await call('ben', 'GET', '/api/external-accounts')).json().accounts).toEqual([])
    expect((await call('amy', 'GET', '/api/external-accounts')).json().accounts).toHaveLength(1)
  })

  it('answers 404 for ids that are not ids', async () => {
    for (const id of ['0', 'abc', '1e3', '01', '99999999999999999999']) {
      expect((await call('amy', 'DELETE', `/api/external-accounts/${id}`)).status).toBe(404)
    }
  })

  it('has one spelling per URL: a trailing slash or an empty segment is a 404 before any handler', async () => {
    for (const path of [
      '/api/external-accounts/',
      '/api/external-accounts//1',
      '/api/external-accounts/1/',
    ]) {
      expect((await call('amy', 'GET', path)).status).toBe(404)
    }
  })
})

describe('the proxy route', () => {
  async function plainAccount(user = 'pat') {
    return (await addAccount(user, { name: 'Open', url: home(), authMode: 'none' })).account
  }
  async function loginAccount(user = 'pat') {
    fake.setLogin(LOGIN)
    return addAccount(user, {
      name: 'Work',
      url: home(),
      authMode: 'basic',
      username: LOGIN.username,
      password: LOGIN.password,
    })
  }

  it('PROPFIND with a body and a Depth reaches the account’s server and the answer comes back', async () => {
    const { id } = await plainAccount()
    const body = '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>'
    const reply = await call('pat', 'PROPFIND', proxy(id, PATHS.home), {
      raw: body,
      headers: { depth: '1', 'content-type': 'application/xml' },
    })
    expect(reply.status).toBe(207)
    expect(reply.text).toContain(PATHS.calendar)
    expect(reply.headers.get('x-upstream-status')).toBe('207')
    expect(reply.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ method: 'PROPFIND', url: PATHS.home, body })
    expect(fake.requests[0]!.headers.depth).toBe('1')
  })

  it('REPORT, GET, HEAD and OPTIONS work; the root and a trailing slash pass the API guards', async () => {
    const { id } = await plainAccount()
    const report = await call('pat', 'REPORT', proxy(id, PATHS.calendar), {
      raw: '<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"/>',
      headers: { depth: '1' },
    })
    expect([report.status, report.text.includes('BEGIN:VEVENT')]).toEqual([207, true])
    expect((await call('pat', 'GET', proxy(id, PATHS.event))).status).toBe(200)
    const head = await call('pat', 'HEAD', proxy(id, PATHS.event))
    expect([head.status, head.text, head.headers.get('etag')]).toEqual([200, '', '"fake-etag-1"'])
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(100)
    expect((await call('pat', 'OPTIONS', proxy(id, PATHS.calendar))).headers.get('dav')).toBe(
      '1, 3, calendar-access',
    )
    // `/api/external/<id>/` is the root of the account’s server.
    const root = await call('pat', 'PROPFIND', `/api/external/${id}/`, { headers: { depth: '0' } })
    expect(root.status).toBe(207)
    expect(fake.requests.at(-1)!.url).toBe('/')
  })

  it('keeps the query string and sends the path as written', async () => {
    const { id } = await plainAccount()
    fake.route('/q/', (recorded, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(recorded.url)
    })
    expect((await call('pat', 'GET', proxy(id, '/q/?a=1&b=%2F'))).text).toBe('/q/?a=1&b=%2F')
  })

  it('answers every method it does not forward with a JSON 405 and an Allow header', async () => {
    const { id } = await plainAccount()
    for (const method of [
      'PUT',
      'DELETE',
      'POST',
      'PATCH',
      'PROPPATCH',
      'MKCOL',
      'MKCALENDAR',
      'COPY',
      'MOVE',
    ]) {
      const reply = await call(
        'pat',
        method,
        proxy(id, PATHS.event),
        method === 'PUT' || method === 'POST' || method === 'PATCH' ? { raw: 'x' } : {},
      )
      expect([method, reply.status, reply.json()]).toEqual([
        method,
        405,
        { error: 'method_not_allowed' },
      ])
      expect(reply.headers.get('allow')).toBe('PROPFIND, REPORT, GET, HEAD, OPTIONS')
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('answers 400 invalid_path for a path that could leave the account’s server, and sends nothing', async () => {
    const { id } = await plainAccount()
    for (const target of [
      `/api/external/${id}`,
      `/api/external/${id}?x=1`,
      `/api/external/${id}/dav/../admin`,
      `/api/external/${id}/dav/%2e%2e/admin`,
      `/api/external/${id}/dav/..%2fadmin`,
      `/api/external/${id}/dav/a%5cb`,
      `/api/external/${id}/dav/a%00b`,
    ]) {
      const reply = await raw('pat', 'GET', target)
      expect([target, reply.status, reply.text]).toEqual([target, 400, '{"error":"invalid_path"}'])
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('answers 404 before the handler for an empty segment, with the API’s usual 404', async () => {
    const { id } = await plainAccount()
    for (const target of [`/api/external/${id}//victim.example/x`, `/api/external/${id}/dav//x`]) {
      const reply = await raw('pat', 'GET', target)
      expect([target, reply.status]).toEqual([target, 404])
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('does not take the origin from anywhere else: not from a header, not from the path', async () => {
    const { id } = await plainAccount()
    // Sent over a plain socket, so that no client library decides which headers are real.
    const reply = await raw('pat', 'GET', proxy(id, PATHS.event), {
      headers: {
        host: `127.0.0.2:${victim.port}`,
        'x-forwarded-host': victim.host,
        'x-original-url': victim.url('/'),
        forwarded: `host=${victim.host}`,
      },
    })
    // The app did receive them…
    expect(lastReceived()).toMatchObject({
      host: `127.0.0.2:${victim.port}`,
      'x-forwarded-host': victim.host,
      'x-original-url': victim.url('/'),
    })
    // …and the request still went to the account’s own server.
    expect(reply.status).toBe(200)
    expect(victim.requests).toHaveLength(0)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.headers.host).toBe(`${fake.host}:${fake.port}`)
    expect((await raw('pat', 'GET', `/api/external/${id}/${victim.url('/')}`)).status).toBe(404)
    expect(victim.requests).toHaveLength(0)
  })

  it('forwards nothing of the app’s own request and brings nothing of the server’s own answer', async () => {
    const { id } = await plainAccount()
    const reply = await raw('pat', 'GET', proxy(id, PATHS.event), {
      headers: {
        cookie: 'session=SECRET',
        'x-forwarded-for': '203.0.113.9',
        'x-remote-user': 'root',
        origin: 'http://app.example',
        referer: 'http://app.example/settings?token=SECRET',
        'if-none-match': '"x"',
        'x-upstream-authorization': 'Sealed whatever',
      },
    })
    // The app did receive them (a positive control: the assertions below are about the proxy)…
    expect(lastReceived()).toMatchObject({
      cookie: 'session=SECRET',
      'x-forwarded-for': '203.0.113.9',
      'x-remote-user': 'root',
      origin: 'http://app.example',
      referer: 'http://app.example/settings?token=SECRET',
      'if-none-match': '"x"',
      authorization: 'Bearer test-pat',
    })
    // …and the account’s server did not.
    expect(reply.status).toBe(200)
    const upstream = fake.requests[0]!.headers
    expect(Object.keys(upstream).sort()).toEqual(
      ['accept-encoding', 'connection', 'host', 'user-agent'].sort(),
    )
    expect(upstream['user-agent']).toBe('web-calendar')
    expect(JSON.stringify(upstream)).not.toMatch(/SECRET|test-pat|203\.0\.113|root|app\.example/)
    expect(reply.headers.get('set-cookie')).toBeNull()
    expect(reply.headers.get('server')).toBeNull()
    expect(reply.headers.get('x-powered-by')).toBeNull()
    expect(reply.headers.get('www-authenticate')).toBeNull()
  })

  it('protects every answer: no-store, the sandbox, nosniff', async () => {
    const { id } = await plainAccount()
    for (const reply of [
      await call('pat', 'GET', proxy(id, PATHS.event)),
      await call('pat', 'DELETE', proxy(id, PATHS.event)),
      await call('pat', 'GET', proxy(9999, PATHS.event)),
      await raw('pat', 'GET', `/api/external/${id}/../x`),
    ]) {
      expect(reply.headers.get('cache-control')).toBe('no-store')
      expect(reply.headers.get('content-security-policy')).toBe(RESOURCE_CSP)
      expect(reply.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('answers {"error":"account_not_found"} (404) for a missing and for another user’s account', async () => {
    const { id } = await plainAccount('pat')
    for (const [user, account] of [
      ['pat', 9999],
      ['quinn', id],
    ] as const) {
      const reply = await call(user, 'GET', proxy(account, PATHS.event))
      expect([reply.status, reply.json()]).toEqual([404, { error: 'account_not_found' }])
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('sends the login of an account with one: the seal from the account API opens, the calendar answers', async () => {
    const { account, sealed: seal } = await loginAccount()
    const reply = await call('pat', 'PROPFIND', proxy(account.id, PATHS.home), {
      headers: { depth: '1', ...sealed(seal!) },
    })
    expect(reply.status).toBe(207)
    expect(fake.requests[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('alice:pw-alice').toString('base64')}`,
    )
    expect(JSON.stringify(fake.requests[0]!.headers)).not.toContain(seal!)
  })

  it('answers 428 for a missing, foreign or void seal, and never 401', async () => {
    const { account, sealed: seal } = await loginAccount()
    const other = await loginAccountFor('pat2', victim.url(PATHS.home))
    const attempts: Record<string, string>[] = [
      {},
      sealed('garbage'),
      sealed(other.sealed!), // another account’s seal
      { [EXTERNAL_CREDENTIAL_HEADER]: `Basic ${seal}` },
    ]
    for (const headers of attempts) {
      const reply = await call('pat', 'GET', proxy(account.id, PATHS.event), { headers })
      expect([reply.status, reply.json()]).toEqual([428, { error: 'credential_required' }])
    }
    // The same seal under another user’s token: the account is not theirs.
    const stolen = await call('quinn', 'GET', proxy(account.id, PATHS.event), {
      headers: sealed(seal!),
    })
    expect([stolen.status, stolen.json()]).toEqual([404, { error: 'account_not_found' }])
    expect(fake.requests).toHaveLength(0)
  })

  async function loginAccountFor(user: string, url: string) {
    return addAccount(user, {
      name: 'Other',
      url,
      authMode: 'basic',
      username: 'alice',
      password: 'pw',
    })
  }

  it('a seal stops working when the user name or the address of the account changes, and a new one takes over', async () => {
    const { account, sealed: oldSeal } = await loginAccount()
    const changed = await call('pat', 'PUT', `/api/external-accounts/${account.id}`, {
      body: { username: 'alice2', password: 'pw2' },
    })
    expect(changed.status).toBe(200)
    fake.setLogin({ username: 'alice2', password: 'pw2' })

    const old = await call('pat', 'GET', proxy(account.id, PATHS.event), {
      headers: sealed(oldSeal!),
    })
    expect([old.status, old.json()]).toEqual([428, { error: 'credential_required' }])
    const fresh = await call('pat', 'GET', proxy(account.id, PATHS.event), {
      headers: sealed(changed.json().sealed),
    })
    expect(fresh.status).toBe(200)
    expect(fake.requests.at(-1)!.headers.authorization).toBe(
      `Basic ${Buffer.from('alice2:pw2').toString('base64')}`,
    )

    // A new address: the seal made for the old origin does not open for the new one, so a script
    // that moves the account cannot take the stored login along.
    const moved = await call('pat', 'PUT', `/api/external-accounts/${account.id}`, {
      body: { url: victim.url(PATHS.home), password: 'pw2' },
    })
    expect(moved.status).toBe(200)
    const stale = await call('pat', 'GET', proxy(account.id, PATHS.event), {
      headers: sealed(changed.json().sealed),
    })
    expect(stale.status).toBe(428)
    expect(victim.requests).toHaveLength(0)
  })

  it('maps the account’s 401 to a 502 with X-Upstream-Status, so the browser keeps its own login', async () => {
    const { account, sealed: seal } = await loginAccount()
    fake.setLogin({ username: 'alice', password: 'changed-on-the-server' })
    const reply = await call('pat', 'GET', proxy(account.id, PATHS.event), {
      headers: sealed(seal!),
    })
    expect([reply.status, reply.json()]).toEqual([502, { error: 'upstream_login_failed' }])
    expect(reply.headers.get('x-upstream-status')).toBe('401')
    expect(reply.headers.get('www-authenticate')).toBeNull()
  })

  it('refuses a redirect to another origin without sending the login there', async () => {
    const { account, sealed: seal } = await loginAccount()
    const reply = await call('pat', 'PROPFIND', proxy(account.id, PATHS.redirectCross), {
      headers: { depth: '0', ...sealed(seal!) },
    })
    expect([reply.status, reply.json()]).toEqual([502, { error: 'redirect_refused' }])
    expect(reply.headers.get('location')).toBeNull()
    expect(victim.requests).toHaveLength(0)
  })

  it('limits the request body to the API’s cap, announced or chunked', async () => {
    const { id } = await plainAccount()
    const over = await call('pat', 'PROPFIND', proxy(id, PATHS.home), {
      raw: 'x'.repeat(API_MAX_BODY_BYTES + 1),
      headers: { depth: '0' },
    })
    expect([over.status, over.json()]).toEqual([413, { error: 'request_too_large' }])

    const chunked = await new Promise<Reply>((resolve, reject) => {
      const request = httpRequest(
        base,
        {
          method: 'PROPFIND',
          path: proxy(id, PATHS.home),
          headers: { authorization: 'Bearer test-pat', 'transfer-encoding': 'chunked', depth: '0' },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: response.statusCode ?? 0,
              headers: new Headers(),
              text,
              json: () => JSON.parse(text),
            })
          })
        },
      )
      request.on('error', reject)
      request.write('<a/>')
      request.end()
    })
    expect([chunked.status, chunked.json()]).toEqual([411, { error: 'length_required' }])
    expect(fake.requests).toHaveLength(0)
  })

  it('does not forward a body of GET', async () => {
    const { id } = await plainAccount()
    const reply = await raw('pat', 'GET', proxy(id, PATHS.event), {
      body: 'x',
      headers: { 'content-length': '1' },
    })
    expect([reply.status, reply.text]).toEqual([400, '{"error":"invalid_request"}'])
    expect(fake.requests).toHaveLength(0)
  })

  it('limits the rate of a user: 60 at once, then 429 with Retry-After; others are not affected', async () => {
    const { id } = await plainAccount('rob')
    const replies: Reply[] = []
    for (let i = 0; i < 150; i++)
      replies.push(await call('rob', 'OPTIONS', proxy(id, PATHS.calendar)))
    const limited = replies.filter((reply) => reply.status === 429)
    expect(limited.length).toBeGreaterThanOrEqual(5)
    expect(limited[0]!.json()).toEqual({ error: 'rate_limited' })
    expect(Number(limited[0]!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(replies.slice(0, 60).every((reply) => reply.status === 200)).toBe(true)
    expect((await call('pat', 'GET', '/api/external-accounts')).status).toBe(200)
  })
})

describe('what the router knows', () => {
  it('has the account routes and the proxy under one prefix each, and the bare id as a route', () => {
    const routes = routeFiles()
      .map(({ route, method }) => `${method ?? 'all'} ${route}`)
      .filter((line) => line.includes('/api/external'))
      .sort()
    expect(routes).toEqual(
      [
        'all /api/external/:id',
        'all /api/external/:id/**:path',
        'delete /api/external-accounts/:id',
        'get /api/external-accounts',
        'post /api/external-accounts',
        'post /api/external-accounts/:id/credential',
        'put /api/external-accounts/:id',
      ].sort(),
    )
  })
})
