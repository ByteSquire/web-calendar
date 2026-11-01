import { Readable } from 'node:stream'
import { getRequestIP, type H3Event } from 'h3'
import { lastForwardedHop, sharedAddressWarning } from '../auth/client-address'
import { authenticateCalDav } from '../auth/nitro'
import { emitChallengeLines } from './challenges'
import { parseCorsOrigins } from './cors'
import { getDb } from '../db'
import { groupFilePath } from '../group-sync/config'
import { createFileMembership } from '../sharing/membership'
import { createPathPrecheck, type PathPrecheck } from '../sharing/precheck'
import { createGateway, type GatewayRequest } from './gateway'

// Nitro glue: reads the runtime config and adapts the Node request. The logic is in the plain modules.

let gateway: ReturnType<typeof createGateway> | undefined
let precheck: PathPrecheck | undefined
let trustForwardedFor = false
let warnedSharedAddress = false

function getGateway() {
  if (!gateway) {
    const { gateway: config, radicale, groupSync, demo } = useRuntimeConfig()
    const { origins, invalid } = parseCorsOrigins(config.corsOrigins)
    if (invalid.length > 0) {
      console.warn(`[gateway] ignoring invalid CORS origins: ${invalid.join(', ')}`)
    }
    const maxBodyBytes = Number(config.maxBodyBytes)
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new Error(
        `NUXT_GATEWAY_MAX_BODY_BYTES must be a positive integer, got "${config.maxBodyBytes}"`,
      )
    }
    const maxConcurrentPerUser = Number(config.maxConcurrentPerUser)
    if (!Number.isSafeInteger(maxConcurrentPerUser) || maxConcurrentPerUser <= 0) {
      throw new Error(
        `NUXT_GATEWAY_MAX_CONCURRENT_PER_USER must be a positive integer, got "${config.maxConcurrentPerUser}"`,
      )
    }
    // Env overrides are parsed like `icalProxy.allowPrivate`: only the text "true" turns it on.
    trustForwardedFor = String(config.trustForwardedFor) === 'true'
    const precheckMembership = createFileMembership(
      groupFilePath(groupSync.file, process.env.NODE_ENV),
      (message) => console.warn(`[gateway] ${message}`),
    )
    gateway = createGateway({
      upstream: radicale.url,
      corsOrigins: origins,
      maxBodyBytes,
      maxConcurrentPerUser,
      authenticate: authenticateCalDav,
      // Group membership comes from the file Radicale reads, so both agree. Demo mode has no
      // database (and no Radicale behind the gateway).
      precheck:
        String(demo) === 'true'
          ? undefined
          : (sub, request) => {
              // Built on first use: the database opens after the plugins start.
              precheck ??= createPathPrecheck(getDb(), precheckMembership)
              return precheck(sub, request)
            },
      log: (message, cause) => console.warn(`[gateway] ${message}`, cause ?? ''),
    })
  }
  return gateway
}

/**
 * The address the login throttle counts a request against: the socket's peer, or, with
 * `gateway.trustForwardedFor`, the address our reverse proxy appended to `X-Forwarded-For` (see
 * `lastForwardedHop` for why that is the last entry and when it may be trusted).
 */
function clientAddress(event: H3Event): string | null {
  if (trustForwardedFor) {
    const hop = lastForwardedHop(event.headers.get('x-forwarded-for'))
    if (hop !== null) return hop
  }
  return getRequestIP(event) ?? null
}

/**
 * Without `trustForwardedFor`, requests that reach us from a loopback or private address probably
 * come through a reverse proxy; say so once (see `sharedAddressWarning`).
 */
function warnAboutSharedAddress(event: H3Event): void {
  if (warnedSharedAddress) return
  const warning = sharedAddressWarning(getRequestIP(event), trustForwardedFor)
  if (warning === null) return
  warnedSharedAddress = true
  console.warn(`[gateway] ${warning}`)
}

/**
 * Hands a request to the gateway and returns its web `Response`. h3's own helpers (`proxyRequest`,
 * `toWebRequest`) skip the body of methods other than POST, PUT, PATCH and DELETE, which would lose
 * the XML of PROPFIND and REPORT, so the Node request is adapted here.
 */
export function handleGatewayRequest(event: H3Event): Promise<Response> {
  // First, so the configuration (`trustForwardedFor`) is read before the address is.
  const handle = getGateway()
  warnAboutSharedAddress(event)
  const { req, res } = event.node
  const hasBody =
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  const abort = new AbortController()
  res.once('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  const request: GatewayRequest = {
    method: req.method ?? 'GET',
    target: req.url ?? '/',
    headers: event.headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    signal: abort.signal,
    clientAddress: clientAddress(event),
  }
  // The challenges of a 401 go out as separate lines, which a web `Response` cannot express.
  return handle(request).then((response) => {
    emitChallengeLines(res, response)
    return response
  })
}
