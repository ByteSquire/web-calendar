// A `fetch` that adds the bearer token (design §6) to requests for the app's own origin. On a 401
// it asks for a renewed token and sends the request once more. Pure: the token source and the
// underlying fetch are parameters, so tests/auth-fetch.test.ts runs it without a browser.
import type { TokenProvider } from './types'

export interface AuthFetchOptions {
  /**
   * The origin of the app. Only requests to this origin get the token; the default is the page's
   * (`location.origin`). Tests pass one because `location` is not a real origin there.
   */
  origin?: string
}

type Input = Parameters<typeof fetch>[0]
type Init = Parameters<typeof fetch>[1]

function resolveUrl(input: Input, origin: string): URL | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new URL(raw, origin)
  } catch {
    return null
  }
}

/**
 * Whether the body can be sent a second time. A stream is consumed by the first attempt; the
 * other kinds are re-read from memory for each attempt.
 */
function isReplayable(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return true
  if (typeof body === 'string') return true
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false
  return (
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  )
}

export function createAuthFetch(
  getToken: TokenProvider,
  baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
  options: AuthFetchOptions = {},
): typeof fetch {
  return async function authFetch(input: Input, init?: Init): Promise<Response> {
    const origin = options.origin ?? globalThis.location?.origin ?? ''
    const target = resolveUrl(input, origin)
    // The token belongs to this app only: any other origin (an external calendar server) gets the
    // request untouched, and so does a URL that cannot be understood.
    if (!target || target.origin !== origin) return baseFetch(input, init)

    const request = typeof input === 'string' || input instanceof URL ? null : input
    const replayable = init?.body !== undefined ? isReplayable(init.body) : true

    // A Request's body can be read once: send clones, so the original stays unused for the retry.
    const send = (token: string): Promise<Response> => {
      // As in `new Request(request, init)`: headers in `init` replace the request's own.
      const headers = new Headers(init?.headers ?? request?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      // A redirect to another origin drops the Authorization header (fetch spec), so the token
      // does not follow the request there.
      return request
        ? baseFetch(new Request(request.clone(), { ...init, headers }))
        : baseFetch(input, { ...init, headers })
    }

    const token = await getToken()
    const response = await send(token)
    if (response.status !== 401 || !replayable) return response

    // The token was refused (revoked, or expired between the check and the arrival). Renew and
    // try once more; a second 401 is the answer.
    await response.body?.cancel().catch(() => undefined)
    return send(await getToken({ rejectedToken: token }))
  }
}
