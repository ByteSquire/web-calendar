import { AuthError } from '../auth/errors'
import { BodyTooLargeError, limitStream, readLimited } from './body'
import { rememberChallengeLines } from './challenges'
import { allowedOrigin, applyCors, isPreflight, preflightResponse } from './cors'
import {
  ALLOWED_METHODS,
  buildUpstreamHeaders,
  filterResponseHeaders,
  isAllowedMethod,
} from './headers'
import type { PathPrecheck } from '../sharing/precheck'
import { GATEWAY_PREFIX, PathRejection, resolvePublicPath, rewriteDestination } from './paths'

export interface GatewayRequest {
  method: string
  /** The raw request target (path and query) exactly as the client sent it. */
  target: string
  headers: Headers
  /** The request body, or null when the request has none. */
  body: ReadableStream<Uint8Array> | null
  /** Aborted when the client goes away. */
  signal?: AbortSignal
  /** The address the request came from, for the login throttle; null or absent when unknown. */
  clientAddress?: string | null
}

/** What `authenticate` is told about the request besides its headers. */
export interface AuthenticateContext {
  clientAddress: string | null
}

export interface GatewayOptions {
  /** Internal URL of Radicale, for example `http://radicale:5232`. */
  upstream: string
  /** Origins that may call the gateway from a browser; empty means none (no CORS headers at all). */
  corsOrigins?: readonly string[]
  /** Largest request body forwarded, in bytes. */
  maxBodyBytes: number
  /** Resolves the caller or throws `AuthError`. */
  authenticate(headers: Headers, context: AuthenticateContext): Promise<{ sub: string }>
  /**
   * Second opinion from SQLite before a request is forwarded (security review §7.1): false answers
   * 403 without saying whether the path exists. Absent means no check (tests of the plain proxy).
   */
  precheck?: PathPrecheck
  fetch?: typeof globalThis.fetch
  log?: (message: string, cause?: unknown) => void
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

/**
 * The body of a request over the limit is not read to its end, so the connection cannot carry the
 * next request: the answer ends it. Without `Connection: close` the client would reuse a socket
 * that is already gone.
 */
function payloadTooLarge(): Response {
  return text(413, 'Payload Too Large', { connection: 'close' })
}

/**
 * The CalDAV gateway (design §7): authenticates the request, checks method and path, and forwards it
 * to Radicale with the caller's identity in `X-Remote-User`. Radicale trusts that header, so it is
 * set here and nowhere else; see `buildUpstreamHeaders`.
 */
export function createGateway(
  options: GatewayOptions,
): (request: GatewayRequest) => Promise<Response> {
  const upstreamBase = new URL(options.upstream).href.replace(/\/+$/, '')
  const corsOrigins = options.corsOrigins ?? []
  const maxBodyBytes = options.maxBodyBytes
  const doFetch = options.fetch ?? globalThis.fetch
  const log = options.log ?? (() => undefined)

  function authFailure(error: AuthError): Response {
    // Every client's first request has no credentials, by design; that is not worth a log line. A
    // throttled client would log on every request; the throttle reports when it starts blocking.
    if (error.reason !== 'no-credentials' && error.reason !== 'throttled') {
      log(`authentication failed: ${error.reason}`)
    }
    if (error.status === 503) {
      return text(503, 'Service Unavailable', { 'retry-after': '5' })
    }
    if (error.status === 429) {
      return text(429, 'Too Many Requests', { 'retry-after': String(error.retryAfterSec ?? 1) })
    }
    const response = text(401, 'Unauthorized')
    for (const challenge of error.challenges) response.headers.append('www-authenticate', challenge)
    // `Headers` joins them; the Nitro glue sends them as separate lines.
    rememberChallengeLines(response, error.challenges)
    return response
  }

  function rejection(error: PathRejection, what: 'path' | 'destination'): Response {
    if (error.kind === 'malformed') return text(400, `Bad Request: ${error.message}`)
    return what === 'path'
      ? text(404, 'Not Found')
      : text(403, 'Forbidden: destination not allowed')
  }

  async function route(request: GatewayRequest, origin: string | null): Promise<Response> {
    const { method, headers } = request
    if (!isAllowedMethod(method)) {
      return text(405, 'Method Not Allowed', { allow: ALLOWED_METHODS.join(', ') })
    }
    // The one unauthenticated request: browsers send no credentials in a preflight.
    if (origin !== null && isPreflight(method, headers)) return preflightResponse()

    let identity: { sub: string }
    try {
      identity = await options.authenticate(headers, {
        clientAddress: request.clientAddress ?? null,
      })
    } catch (error) {
      if (error instanceof AuthError) return authFailure(error)
      throw error
    }

    let upstreamPath: string
    try {
      upstreamPath = resolvePublicPath(request.target).upstreamPath
    } catch (error) {
      if (error instanceof PathRejection) return rejection(error, 'path')
      throw error
    }
    let destination: string | undefined
    if (method === 'COPY' || method === 'MOVE') {
      const value = headers.get('destination')
      if (value === null) return text(400, 'Bad Request: Destination header required')
      try {
        destination = rewriteDestination(value)
      } catch (error) {
        if (error instanceof PathRejection) return rejection(error, 'destination')
        throw error
      }
    }

    if (options.precheck) {
      const targets = [upstreamPath]
      // The destination is already a public path under /caldav/.
      if (destination !== undefined) targets.push(destination.slice(GATEWAY_PREFIX.length) || '/')
      for (const path of targets) {
        if (!(await options.precheck(identity.sub, { method, upstreamPath: path }))) {
          return text(403, 'Forbidden')
        }
      }
    }

    const lengthHeader = headers.get('content-length')
    let declared: number | null = null
    if (lengthHeader !== null) {
      if (!/^\d{1,15}$/.test(lengthHeader.trim())) return text(400, 'Bad Request: Content-Length')
      declared = Number(lengthHeader)
      if (declared > maxBodyBytes) return payloadTooLarge()
    }

    // Radicale reads a request body by Content-Length only and treats a chunked one as empty, so a
    // body of unknown length is read here first (up to the limit) and sent with its length.
    let body: ReadableStream<Uint8Array> | Uint8Array | undefined
    let contentLength: number | undefined
    let exceeded = false
    if (request.body && method !== 'GET' && method !== 'HEAD' && declared !== 0) {
      if (declared !== null) {
        body = limitStream(request.body, maxBodyBytes, () => (exceeded = true))
        contentLength = declared
      } else {
        try {
          body = await readLimited(request.body, maxBodyBytes)
        } catch (error) {
          if (error instanceof BodyTooLargeError) return payloadTooLarge()
          throw error
        }
        contentLength = body.byteLength
      }
    } else {
      await request.body?.cancel().catch(() => undefined)
    }

    let upstream: Response
    try {
      upstream = await doFetch(upstreamBase + upstreamPath, {
        method,
        headers: buildUpstreamHeaders(headers, { sub: identity.sub, destination, contentLength }),
        body: contentLength ? (body as BodyInit) : undefined,
        // Required by fetch for a streamed body.
        duplex: 'half',
        // Redirects are the client's business; following one could leave /caldav/.
        redirect: 'manual',
        signal: request.signal,
      } as RequestInit)
    } catch (error) {
      if (exceeded) return payloadTooLarge()
      if (!request.signal?.aborted) log('upstream request failed', error)
      return text(502, 'Bad Gateway')
    }

    if (upstream.status === 401) {
      // The gateway always sends an identity, so this is a configuration fault, not the client's.
      await upstream.body?.cancel().catch(() => undefined)
      log('Radicale rejected the gateway identity (401); check its auth settings')
      return text(502, 'Bad Gateway')
    }
    const hasBody = method !== 'HEAD' && ![204, 205, 304].includes(upstream.status)
    if (!hasBody) await upstream.body?.cancel().catch(() => undefined)
    return new Response(hasBody ? upstream.body : null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: filterResponseHeaders(upstream.headers),
    })
  }

  return async function handle(request) {
    const origin = allowedOrigin(request.headers.get('origin'), corsOrigins)
    let response: Response
    try {
      response = await route(request, origin)
    } catch (error) {
      log('gateway error', error)
      response = text(500, 'Internal Server Error')
    }
    // With CORS off there are no CORS headers on any response, the 401 and 429 included.
    if (corsOrigins.length > 0) applyCors(response.headers, origin)
    return response
  }
}
