// The CalDAV gateway behind a plain Node HTTP server, wired to the fake identity provider and the
// fake Radicale of scripts/test-gateway-prod.mjs. It stands in for the Nitro server, which cannot
// run without a build: it lets the fakes be tested against the real gateway, verifier and app-token
// code over HTTP (tests/scripts/gateway-stack.test.ts), and lets the integration suites be tried
// without a build. Only what those suites touch is served: `/caldav/**`, `/.well-known/caldav` and
// `/api/config`. Everything else answers 404.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import {
  createApp,
  createError,
  defineEventHandler,
  getRequestIP,
  sendRedirect,
  toNodeListener,
  type H3Event,
} from 'h3'
import { fileURLToPath } from 'node:url'
import { createAppToken, verifyAppToken } from '../../server/db/app-tokens'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { upsertUser } from '../../server/db/users'
import { authenticateRequest } from '../../server/utils/auth/authenticate'
import { buildAllowedClients } from '../../server/utils/auth/clients'
import { createTokenVerifier } from '../../server/utils/auth/jwt'
import { createBasicThrottle } from '../../server/utils/auth/throttle'
import { emitChallengeLines } from '../../server/utils/gateway/challenges'
import { createGateway } from '../../server/utils/gateway/gateway'
import { startFakeIdp } from '../../scripts/lib/fake-idp.mjs'
import { startFakeRadicale } from '../../scripts/lib/fake-radicale.mjs'

const HASH_KEY = 'gateway-stack-hash-key-gateway-stack'
const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

export async function startGatewayStack() {
  const idp = await startFakeIdp()
  const radicale = await startFakeRadicale()
  const db = openDatabase(':memory:')
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
  const { alice, bob } = idp.users
  const aliceId = upsertUser(db, { sub: alice!.sub, username: 'alice' }).id
  upsertUser(db, { sub: bob!.sub, username: 'bob' })
  const aliceAppToken = createAppToken(db, HASH_KEY, aliceId, 'gateway stack').token

  const verifier = createTokenVerifier({
    clients: buildAllowedClients({
      issuer: idp.issuer,
      clientId: idp.clientId,
      allowedClients: '',
    }),
    requiredScope: 'caldav',
  })
  const throttle = createBasicThrottle()
  const gateway = createGateway({
    upstream: radicale.url,
    maxBodyBytes: 10 * 1024 * 1024,
    authenticate: (headers, context) =>
      authenticateRequest(headers, {
        verifier,
        verifyAppToken: (username, token) =>
          verifyAppToken(db, HASH_KEY, username, token, 30 * 24 * 60 * 60 * 1000),
        basicThrottle: throttle,
        clientAddress: context.clientAddress,
      }),
  })

  // What server/utils/gateway/nitro.ts does with the Node request, behind the same h3 listener that
  // Nitro's node-server preset uses.
  function caldav(event: H3Event): Promise<Response> {
    const { req, res } = event.node
    const hasBody =
      req.headers['transfer-encoding'] !== undefined ||
      Number(req.headers['content-length'] ?? 0) > 0
    const abort = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    return gateway({
      method: req.method ?? 'GET',
      target: req.url ?? '/',
      headers: event.headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
      signal: abort.signal,
      clientAddress: getRequestIP(event) ?? null,
    }).then((response) => {
      emitChallengeLines(res, response)
      return response
    })
  }

  const app = createApp().use(
    defineEventHandler((event) => {
      const path = event.path.split('?')[0]
      if (path === '/api/config') {
        return {
          oidc: { issuer: idp.issuer, clientId: idp.clientId, scope: 'openid caldav' },
          demo: false,
          timezone: process.env.TZ || 'Europe/Berlin',
          signinWindowDays: 30,
        }
      }
      if (path === '/.well-known/caldav') {
        if (event.method === 'POST') throw createError({ statusCode: 405 })
        return sendRedirect(event, '/caldav/', 301)
      }
      if (path === '/caldav' || path?.startsWith('/caldav/')) return caldav(event)
      throw createError({ statusCode: 404 })
    }),
  )
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    base,
    idp,
    radicale,
    alice: alice!,
    bob: bob!,
    aliceAppToken,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
      await Promise.all([idp.close(), radicale.close()])
      db.close()
    },
  }
}

export type GatewayStack = Awaited<ReturnType<typeof startGatewayStack>>
