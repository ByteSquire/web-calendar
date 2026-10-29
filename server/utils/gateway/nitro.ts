import { Readable } from 'node:stream'
import type { H3Event } from 'h3'
import { authenticateCalDav } from '../auth/nitro'
import { parseCorsOrigins } from './cors'
import { createGateway, type GatewayRequest } from './gateway'

// Nitro glue: reads the runtime config and adapts the Node request. The logic is in the plain modules.

let gateway: ReturnType<typeof createGateway> | undefined

function getGateway() {
  if (!gateway) {
    const { gateway: config, radicale } = useRuntimeConfig()
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
    gateway = createGateway({
      upstream: radicale.url,
      corsOrigins: origins,
      maxBodyBytes,
      authenticate: authenticateCalDav,
      log: (message, cause) => console.warn(`[gateway] ${message}`, cause ?? ''),
    })
  }
  return gateway
}

/**
 * Hands a request to the gateway and returns its web `Response`. h3's own helpers (`proxyRequest`,
 * `toWebRequest`) skip the body of methods other than POST, PUT, PATCH and DELETE, which would lose
 * the XML of PROPFIND and REPORT, so the Node request is adapted here.
 */
export function handleGatewayRequest(event: H3Event): Promise<Response> {
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
  }
  return getGateway()(request)
}
