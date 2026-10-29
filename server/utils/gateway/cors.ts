import { ALLOWED_METHODS, FORWARDED_REQUEST_HEADERS } from './headers'

/**
 * `gateway.corsOrigins` is a comma-separated list of exact origins such as `https://app.example.org`.
 * Anything else (`*`, `null`, a path, a non-HTTP scheme) is returned in `invalid` and never allowed.
 */
export function parseCorsOrigins(value: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = []
  const invalid: string[] = []
  for (const entry of value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    let origin: string | null = null
    try {
      const url = new URL(entry)
      // A trailing slash is tolerated; any other path, userinfo, query or port syntax is not.
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === entry.replace(/\/$/, '').toLowerCase()
      ) {
        origin = url.origin
      }
    } catch {
      // not a URL
    }
    if (origin === null) invalid.push(entry)
    else if (!origins.includes(origin)) origins.push(origin)
  }
  return { origins, invalid }
}

/** The request's `Origin`, if it is on the allow-list. Compared exactly, never reflected otherwise. */
export function allowedOrigin(origin: string | null, allowed: readonly string[]): string | null {
  return origin !== null && allowed.includes(origin) ? origin : null
}

/** A browser's CORS preflight: an `OPTIONS` with `Origin` and `Access-Control-Request-Method`. */
export function isPreflight(method: string, headers: Headers): boolean {
  return (
    method === 'OPTIONS' && headers.has('origin') && headers.has('access-control-request-method')
  )
}

const EXPOSED_HEADERS = [
  'DAV',
  'ETag',
  'Location',
  'Allow',
  'Content-Type',
  'Content-Length',
  'Last-Modified',
  'WWW-Authenticate',
  'Retry-After',
].join(', ')

const REQUEST_HEADERS = ['authorization', ...FORWARDED_REQUEST_HEADERS, 'destination'].join(', ')

/** Adds the headers that let a browser read the response. No credentials: tokens go in a header. */
export function applyCors(headers: Headers, origin: string | null): void {
  headers.append('vary', 'Origin')
  if (origin === null) return
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-expose-headers', EXPOSED_HEADERS)
}

/** The answer to a preflight from an allowed origin; `applyCors` adds the origin headers. */
export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': ALLOWED_METHODS.join(', '),
      'access-control-allow-headers': REQUEST_HEADERS,
      'access-control-max-age': '600',
    },
  })
}
