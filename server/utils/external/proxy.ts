import type { IncomingHttpHeaders } from 'node:http'
import {
  EXTERNAL_CREDENTIAL_HEADER,
  EXTERNAL_UPSTREAM_STATUS_HEADER,
  type ExternalProxyError,
} from '../../../shared/types/external'
import { API_MAX_BODY_BYTES, apiBodyProblem } from '../api/body-limit'
import { IcalFetchError } from '../ical-proxy/errors'
import { openGuardedRequest } from '../ical-proxy/guarded-request'
import { hostnameOf, hostRefusal, type AddressPolicy } from '../ical-proxy/ssrf'
import { RESOURCE_CSP } from '../security/headers'
import type { UserLimiter } from './limits'
import { sealedFromHeader, type Sealer } from './seal'
import { parseProxyTarget } from './target'

// The pass-through proxy for external CalDAV accounts (FR-8, design §6 item 3, §7). Browsers cannot
// call arbitrary CalDAV servers (CORS), so the SPA sends each request here and this module forwards
// it, statelessly: nothing is stored, no credential outlives the request.
//
// What makes it safe to offer to every signed-in user (security review §5.6):
//   - The target ORIGIN is the one stored in the account's row, never anything from the request;
//     the request only supplies a path and a query (target.ts), checked so they cannot leave it.
//   - Method, request headers and response headers are allow-lists. The app's own `Authorization`,
//     cookies, `X-Forwarded-*` and everything else are not forwarded; `Set-Cookie`,
//     `WWW-Authenticate` and `Location` never come back.
//   - A login is sent to that origin only. It is opened from the sealed credential in
//     `X-Upstream-Authorization` (seal.ts), which opens only for this user, this account and this
//     origin. Redirects are followed only within the origin; a cross-origin one is refused, so a
//     login never follows a redirect.
//   - Every request goes through the shared address policy (host list, SSRF rules, the CalDAV
//     store's host refused), checked again when the socket connects (DNS rebinding).
//   - Everything is bounded: request body, response size (buffered, so a too-large answer is a
//     clean 502, never a truncated multistatus), one deadline for the whole request, per-user
//     rate and concurrency (limits.ts).
//   - A `401` from this route always means "the app's own token is bad", because the browser reacts
//     to it by logging in again. The account's own 401 comes back as a 502 `upstream_login_failed`.
//   - Own failures are `{ "error": "<code>" }`; every proxied answer carries `X-Upstream-Status`.
//   - Logs hold the method, the account id, the host, the status and the duration: never the
//     path, the query, a header or a body.

/** Read-only methods first; writes come later (FR-9). */
export const PROXY_METHODS = ['PROPFIND', 'REPORT', 'GET', 'HEAD', 'OPTIONS'] as const
const METHODS: ReadonlySet<string> = new Set(PROXY_METHODS)
const BODY_METHODS: ReadonlySet<string> = new Set(['PROPFIND', 'REPORT'])

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 20_000
export const MAX_PROXY_REDIRECTS = 3
const USER_AGENT = 'web-calendar'
const MAX_FORWARDED_HEADER_LENGTH = 512
const MAX_RESPONSE_HEADER_LENGTH = 2048
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ACCOUNT_ID = /^[1-9][0-9]{0,14}$/

/** Headers of the account's answer that reach the browser (and `Content-Type` after `safeContentType`). */
const RESPONSE_HEADERS = ['etag', 'dav', 'allow', 'last-modified'] as const

/** What a body of these types can do in the browser is nothing; anything else is sent as bytes. */
const SAFE_MEDIA_TYPES = new Set([
  'application/xml',
  'text/xml',
  'text/calendar',
  'text/plain',
  'application/json',
])

export type OwnErrorCode = ExternalProxyError

/** The account a request is for, as the proxy needs it (the row, not the API shape). */
export interface ProxyAccount {
  id: number
  /** `new URL(url).origin`, the only address requests for this account go to. */
  origin: string
  authMode: 'none' | 'basic'
  username: string | null
}

export interface ProxyRequest {
  user: { id: number; sub: string }
  /** The account id as it stands in the URL; anything but a plain number is "not found". */
  accountId: string
  method: string
  /** The request target after `/api/external/<id>`: path and query, as the client sent them. */
  target: string
  headers: Headers
  /** The request body; null when the request announced none. */
  body: AsyncIterable<Uint8Array> | null
  /** Aborted when the client goes away. */
  signal?: AbortSignal
}

export interface ExternalProxyDeps {
  policy: AddressPolicy
  /** Null without NUXT_EXTERNAL_SEAL_KEY: no login can be opened. */
  sealer: Sealer | null
  /** The user's own account or null (a missing id and someone else's alike). */
  findAccount(userId: number, accountId: number): ProxyAccount | null
  limiter: UserLimiter
  /** A login over plain http; tests and local development only. */
  allowInsecureLogins: boolean
  /** Milliseconds, like `Date.now`. */
  now?: () => number
  log?: (message: string) => void
  maxResponseBytes?: number
  timeoutMs?: number
  maxRequestBytes?: number
  maxRedirects?: number
}

export type ExternalProxy = (request: ProxyRequest) => Promise<Response>

/** A failure on the way to or from the account's server; `kind` is the code the browser gets. */
class UpstreamFailure extends Error {
  constructor(
    readonly kind: Extract<
      OwnErrorCode,
      | 'unreachable'
      | 'timeout'
      | 'too_large'
      | 'bad_response'
      | 'redirect_refused'
      | 'host_not_allowed'
    >,
    /** For the log only; never the URL. */
    readonly detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind)
    this.name = 'UpstreamFailure'
  }
}

const STATUS_OF: Record<OwnErrorCode, number> = {
  method_not_allowed: 405,
  invalid_path: 400,
  invalid_request: 400,
  length_required: 411,
  request_too_large: 413,
  account_not_found: 404,
  host_not_allowed: 403,
  credential_required: 428,
  rate_limited: 429,
  upstream_login_failed: 502,
  redirect_refused: 502,
  bad_response: 502,
  unreachable: 502,
  timeout: 502,
  too_large: 502,
}

/** The headers every answer of the proxy carries; the CSP and `nosniff` are set here, not left to a hook. */
function secureHeaders(headers: Headers): Headers {
  headers.set('cache-control', 'no-store')
  headers.set('content-security-policy', RESOURCE_CSP)
  headers.set('x-content-type-options', 'nosniff')
  return headers
}

function ownError(code: OwnErrorCode, extra: Record<string, string> = {}): Response {
  const headers = secureHeaders(new Headers(extra))
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({ error: code }), { status: STATUS_OF[code], headers })
}

/** The media type as it stands before `;`, lower case. */
function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase()
}

/**
 * The account's `Content-Type` when it is one of a few data types, otherwise `octet-stream`: an
 * HTML, SVG or script answer from a server the user does not control must never be a page of this
 * origin. (The CSP and `nosniff` are the second line.)
 */
export function safeContentType(contentType: string): string {
  return SAFE_MEDIA_TYPES.has(mediaTypeOf(contentType)) ? contentType : 'application/octet-stream'
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The few request headers that are forwarded, or null when one is not a plain value. */
function forwardedHeaders(inbound: Headers): Record<string, string> | null {
  const headers: Record<string, string> = {}
  for (const name of ['accept', 'content-type'] as const) {
    const value = inbound.get(name)
    if (value === null) continue
    if (value.length > MAX_FORWARDED_HEADER_LENGTH || /[^\x20-\x7e]/.test(value)) return null
    headers[name === 'accept' ? 'Accept' : 'Content-Type'] = value
  }
  const depth = inbound.get('depth')
  if (depth !== null) {
    // Without `Depth` a PROPFIND means "infinity": a value that is not one of the three is refused
    // rather than dropped.
    if (!/^(?:0|1|infinity)$/i.test(depth.trim())) return null
    headers.Depth = depth.trim()
  }
  return headers
}

/** The body of a PROPFIND or REPORT: complete, within `max` bytes, before `signal` fires. */
async function readBody(
  source: AsyncIterable<Uint8Array>,
  max: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const iterator = source[Symbol.asyncIterator]()
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new UpstreamFailure('timeout', 'request body'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  const chunks: Buffer[] = []
  let received = 0
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), aborted])
      if (step.done) break
      received += step.value.length
      if (received > max) throw new RangeError('request body over the limit')
      chunks.push(Buffer.from(step.value))
    }
    return Buffer.concat(chunks)
  } finally {
    signal.removeEventListener('abort', onAbort)
    void iterator.return?.()
  }
}

type Hop =
  | { kind: 'response'; status: number; headers: IncomingHttpHeaders; body: Buffer }
  | { kind: 'redirect'; location: string }

interface HopInit {
  method: string
  headers: Record<string, string>
  body: Buffer | null
  policy: AddressPolicy
  maxBytes: number
}

function requestOnce(origin: URL, path: string, init: HopInit, signal: AbortSignal): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false
    let rejectedByGuard: IcalFetchError | undefined
    const request = openGuardedRequest(origin, {
      method: init.method,
      headers: init.headers,
      policy: init.policy,
      path,
      onReject: (error) => {
        rejectedByGuard = error
      },
    })

    function finish(outcome: Hop | UpstreamFailure): void {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (outcome instanceof UpstreamFailure) {
        request.destroy()
        reject(outcome)
      } else {
        resolve(outcome)
      }
    }
    function onAbort(): void {
      finish(new UpstreamFailure('timeout'))
    }

    request.on('error', (error: NodeJS.ErrnoException) => {
      const refusal = rejectedByGuard ?? (error instanceof IcalFetchError ? error : undefined)
      if (refusal) {
        // The policy said no at connect time (the name now resolves somewhere it must not).
        return finish(
          refusal.reason === 'blocked'
            ? new UpstreamFailure('host_not_allowed', refusal.detail)
            : new UpstreamFailure('unreachable', refusal.detail),
        )
      }
      finish(new UpstreamFailure('unreachable', error.code ?? error.message))
    })

    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      const stop = (failure: UpstreamFailure): void => {
        response.destroy()
        finish(failure)
      }

      const location = singleHeader(response.headers.location)
      if (REDIRECT_STATUSES.has(status) && location !== null) {
        response.destroy()
        return finish({ kind: 'redirect', location })
      }

      // Identity only was asked for; a compressed body would have to be size-capped after
      // decompression too, and `Content-Encoding` is not a header that is passed on.
      const encoding = singleHeader(response.headers['content-encoding'])
      if (encoding && encoding.trim().toLowerCase() !== 'identity') {
        return stop(new UpstreamFailure('bad_response', 'unexpected Content-Encoding'))
      }
      // A HEAD answer announces the size of a body it does not have.
      const declared = Number(response.headers['content-length'])
      if (init.method !== 'HEAD' && Number.isFinite(declared) && declared > init.maxBytes) {
        return stop(new UpstreamFailure('too_large', 'Content-Length over the limit'))
      }

      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        received += chunk.length
        if (received > init.maxBytes)
          return stop(new UpstreamFailure('too_large', 'body over the limit'))
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish({ kind: 'response', status, headers: response.headers, body: Buffer.concat(chunks) })
      })
      // A connection that drops mid-body ends with 'error' or only 'close', never 'end'.
      response.on('error', (error: NodeJS.ErrnoException) => {
        finish(new UpstreamFailure('unreachable', error.code ?? error.message))
      })
      response.on('close', () => {
        finish(new UpstreamFailure('unreachable', 'connection closed early'))
      })
    })

    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    request.end(init.body ?? undefined)
  })
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

export function createExternalProxy(deps: ExternalProxyDeps): ExternalProxy {
  const { policy, limiter } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string) => console.info(message))
  const maxResponseBytes = deps.maxResponseBytes ?? MAX_RESPONSE_BYTES
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS
  const maxRequestBytes = deps.maxRequestBytes ?? API_MAX_BODY_BYTES
  const maxRedirects = deps.maxRedirects ?? MAX_PROXY_REDIRECTS

  /**
   * Sends the request to the account's origin and follows redirects within it. Every hop is
   * checked against the policy again and carries the same login, which is safe because it is the
   * same origin; a redirect anywhere else is refused before anything is sent to it.
   */
  async function fetchUpstream(
    account: ProxyAccount,
    path: string,
    init: Omit<HopInit, 'policy' | 'maxBytes'>,
    signal: AbortSignal,
  ): Promise<Extract<Hop, { kind: 'response' }>> {
    const origin = new URL(account.origin)
    // The URL of the current hop, an absolute one so that a relative Location resolves against it
    // (a path such as `//x` would read as a host if it stood alone).
    let current = new URL(`${origin.origin}${path}`)
    let target = path
    for (let hops = 0; ; hops++) {
      if (signal.aborted) throw new UpstreamFailure('timeout')
      const refusal = hostRefusal(hostnameOf(origin), policy)
      if (refusal) throw new UpstreamFailure('host_not_allowed', refusal.detail)

      const hop = await requestOnce(
        origin,
        target,
        { ...init, policy, maxBytes: maxResponseBytes },
        signal,
      )
      if (hop.kind === 'response') return hop

      if (hops >= maxRedirects) throw new UpstreamFailure('redirect_refused', 'too many redirects')
      let next: URL
      try {
        next = new URL(hop.location, current)
      } catch {
        throw new UpstreamFailure('redirect_refused', 'invalid redirect Location')
      }
      // `origin` compares scheme, host and port, in the one spelling `URL` produces.
      if (next.origin !== origin.origin) {
        throw new UpstreamFailure('redirect_refused', 'redirect to another origin')
      }
      current = next
      target = `${next.pathname}${next.search}`
    }
  }

  function proxiedAnswer(method: string, hop: Extract<Hop, { kind: 'response' }>): Response {
    const { status, headers: upstream, body } = hop
    // A 401 means "the app's token is bad" to the browser; the account's own is a gateway failure.
    if (status === 401) {
      return ownError('upstream_login_failed', { [EXTERNAL_UPSTREAM_STATUS_HEADER]: '401' })
    }
    // `Response` rejects other statuses, and a 1xx or a 6xx is not an answer to pass on. A 407 is
    // a proxy asking for a login, which a browser would try to answer itself.
    if (status < 200 || status > 599 || status === 407) {
      throw new UpstreamFailure('bad_response', `status ${status}`)
    }

    const headers = secureHeaders(new Headers())
    for (const name of RESPONSE_HEADERS) {
      const value = singleHeader(upstream[name])
      if (value !== null && value.length <= MAX_RESPONSE_HEADER_LENGTH) headers.set(name, value)
    }
    const contentType = singleHeader(upstream['content-type'])
    if (contentType !== null && contentType.length <= MAX_RESPONSE_HEADER_LENGTH) {
      headers.set('content-type', safeContentType(contentType))
    }
    const hasBody = method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304
    const declared = singleHeader(upstream['content-length'])
    if (declared !== null && /^\d{1,15}$/.test(declared)) {
      headers.set('content-length', hasBody ? String(body.length) : declared)
    }
    headers.set(EXTERNAL_UPSTREAM_STATUS_HEADER, String(status))
    return new Response(hasBody ? new Uint8Array(body) : null, { status, headers })
  }

  return async function handle(request) {
    const started = now()
    let host: string | null = null
    const account = ACCOUNT_ID.test(request.accountId) ? Number(request.accountId) : null

    function done(response: Response, note?: string): Response {
      const label = METHODS.has(request.method) ? request.method : 'other'
      log(
        `[external] ${label} account=${account ?? 'invalid'}${host ? ` host=${host}` : ''} ` +
          `status=${response.status}${note ? ` (${note})` : ''} ${now() - started}ms`,
      )
      return response
    }
    const refuse = (code: OwnErrorCode, extra?: Record<string, string>) =>
      done(ownError(code, extra), code)

    if (!METHODS.has(request.method)) {
      return refuse('method_not_allowed', { allow: PROXY_METHODS.join(', ') })
    }
    const canHaveBody = BODY_METHODS.has(request.method)
    if (request.body !== null && !canHaveBody) return refuse('invalid_request')
    if (canHaveBody) {
      // The method is irrelevant to the header checks of `apiBodyProblem`, which only looks at
      // POST, PUT and PATCH; the limit is the one every `/api/**` body has.
      const problem = apiBodyProblem('POST', request.headers)
      if (problem) {
        return refuse(
          problem.status === 411
            ? 'length_required'
            : problem.status === 413
              ? 'request_too_large'
              : 'invalid_request',
        )
      }
      const length = request.headers.get('content-length')
      if (length !== null && Number(length) > maxRequestBytes) return refuse('request_too_large')
    }
    const target = parseProxyTarget(request.target)
    if (!target.ok) return refuse('invalid_path')
    const forwarded = forwardedHeaders(request.headers)
    if (!forwarded) return refuse('invalid_request')

    const admission = limiter.admit(request.user.id)
    if (!admission.ok) {
      return refuse('rate_limited', { 'retry-after': String(admission.retryAfterSec) })
    }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const onClientGone = (): void => deadline.abort()
    request.signal?.addEventListener('abort', onClientGone, { once: true })

    try {
      const stored = account === null ? null : deps.findAccount(request.user.id, account)
      if (!stored) return refuse('account_not_found')
      host = hostnameOf(new URL(stored.origin))

      // The policy first: a host that left the list, or an http login, is refused before any
      // credential is looked at. (The connection checks the resolved addresses again.)
      const refusal = hostRefusal(host, policy)
      if (refusal) return refuse('host_not_allowed')
      const insecure = new URL(stored.origin).protocol === 'http:'
      if (stored.authMode === 'basic' && insecure && !deps.allowInsecureLogins) {
        return refuse('host_not_allowed')
      }

      const headers: Record<string, string> = {
        ...forwarded,
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity',
        Connection: 'close',
      }
      if (stored.authMode === 'basic') {
        // 428, never 401: a 401 would send the browser to the app's login. Every cause looks alike.
        const sealed = sealedFromHeader(request.headers.get(EXTERNAL_CREDENTIAL_HEADER))
        const login =
          sealed === null || deps.sealer === null
            ? null
            : deps.sealer.open(sealed, {
                sub: request.user.sub,
                accountId: stored.id,
                origin: stored.origin,
              })
        // The user name is not part of the seal's binding, so it is compared here: a seal made
        // before the account's user name changed stops working.
        if (login === null || login.username !== stored.username) {
          return refuse('credential_required')
        }
        headers.Authorization = basicHeader(login.username, login.password)
      }

      let body: Buffer | null = null
      if (canHaveBody) {
        if (request.body !== null) {
          try {
            body = await readBody(request.body, maxRequestBytes, deadline.signal)
          } catch (error) {
            if (error instanceof RangeError) return refuse('request_too_large')
            throw error
          }
        }
        // Radicale-style servers read a body by Content-Length only, and a redirect resends it.
        headers['Content-Length'] = String(body?.length ?? 0)
      }

      const hop = await fetchUpstream(
        stored,
        `${target.path}${target.query}`,
        { method: request.method, headers, body },
        deadline.signal,
      )
      const answer = proxiedAnswer(request.method, hop)
      return done(answer, hop.status === 401 ? 'upstream login failed' : undefined)
    } catch (error) {
      // The note names the failure (never the URL); a bug is reported as a plain 502.
      if (error instanceof UpstreamFailure) return done(ownError(error.kind), error.message)
      return done(ownError('unreachable'), 'unexpected error')
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onClientGone)
      admission.release()
    }
  }
}
