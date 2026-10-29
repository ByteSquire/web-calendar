import { isValidSubject } from '../auth/subject'
import { GATEWAY_PREFIX } from './paths'

/** The only methods the gateway forwards (design §7). */
export const ALLOWED_METHODS = [
  'OPTIONS',
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'PROPFIND',
  'PROPPATCH',
  'REPORT',
  'MKCOL',
  'MKCALENDAR',
  'COPY',
  'MOVE',
] as const

export function isAllowedMethod(method: string): boolean {
  return (ALLOWED_METHODS as readonly string[]).includes(method)
}

/**
 * Request headers that reach Radicale. Everything else is dropped, so a header that Radicale reads
 * in some mode we did not think of (`X-Remote-Addr`, `X-Forwarded-*`, `X-Script-Name`, a method
 * override) cannot be set by a client. `Authorization` and `Cookie` are not on the list; the
 * identity headers are set by the gateway after this filter.
 */
export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'brief',
  'content-language',
  'content-type',
  'depth',
  'if',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-schedule-tag-match',
  'if-unmodified-since',
  'lock-token',
  'overwrite',
  'prefer',
  'schedule-reply',
  'timeout',
  'user-agent',
] as const

export interface UpstreamHeaderOptions {
  /** The authenticated user; becomes `X-Remote-User`. */
  sub: string
  /** The rewritten `Destination` of COPY and MOVE, from `rewriteDestination`. */
  destination?: string
  /** The exact body length; Radicale cannot read chunked request bodies, so it is always sent. */
  contentLength?: number
}

export function buildUpstreamHeaders(inbound: Headers, options: UpstreamHeaderOptions): Headers {
  if (!isValidSubject(options.sub)) throw new TypeError('invalid user id')
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = inbound.get(name)
    if (value !== null) headers.set(name, value)
  }
  if (options.destination !== undefined) headers.set('destination', options.destination)
  if (options.contentLength !== undefined)
    headers.set('content-length', String(options.contentLength))
  // No compression: the body is streamed back untouched.
  headers.set('accept-encoding', 'identity')
  headers.set('x-remote-user', options.sub)
  headers.set('x-script-name', GATEWAY_PREFIX)
  return headers
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Dropped from Radicale's answer; `www-authenticate` and `access-control-*` belong to the gateway. */
const UPSTREAM_ONLY = new Set([
  'set-cookie',
  'set-cookie2',
  'server',
  'x-powered-by',
  'www-authenticate',
])

/** What the client sees of Radicale's response: no cookies, no hop-by-hop headers, no CORS. */
export function filterResponseHeaders(upstream: Headers): Headers {
  const named = new Set(
    (upstream.get('connection') ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  )
  const encoded = upstream.get('content-encoding')?.toLowerCase().trim()
  const decoded = encoded !== undefined && encoded !== 'identity'
  const headers = new Headers()
  for (const [name, value] of upstream) {
    if (HOP_BY_HOP.has(name) || named.has(name) || UPSTREAM_ONLY.has(name)) continue
    if (name.startsWith('access-control-')) continue
    // The body was decoded on the way in, so its length and encoding no longer describe it.
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue
    headers.append(name, value)
  }
  headers.set('x-content-type-options', 'nosniff')
  return headers
}
