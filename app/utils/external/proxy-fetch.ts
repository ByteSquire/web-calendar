// The `fetch` of one external CalDAV account (FR-8, design §7 "External accounts"). Browsers cannot
// call arbitrary CalDAV servers (CORS) and the page's `connect-src` is the app's own origin, so
// every request for the account's server goes to the app's proxy: the URL becomes
// `/api/external/<account id><path><query>`, the app's token is added by the injected `fetch`, and
// for an account with a login the sealed credential travels in `X-Upstream-Authorization`.
//
// The credential belongs to ONE origin. This adapter therefore:
// - rewrites only URLs whose origin equals the account's, and throws for any other (look-alikes,
//   user info, other ports and schemes included); it never falls back to a direct request;
// - sends only the read-only methods the proxy forwards;
// - throws a `DavError` for what the proxy reports about itself or the login, so the callers see
//   a kind (login rejected, password needed, host not allowed, ...) and not an HTTP status. An
//   answer of the account's own server is handed on as it is: the CalDAV client words it.
import {
  EXTERNAL_CREDENTIAL_HEADER,
  EXTERNAL_PROXY_PREFIX,
  type ExternalAccount,
} from '../../../shared/types/external'
import { DavError, errorForStatus, type DavErrorKind } from '../caldav/errors'

/** The methods the proxy forwards. External calendars are read-only for now. */
export const PROXY_METHODS: ReadonlySet<string> = new Set([
  'PROPFIND',
  'REPORT',
  'GET',
  'HEAD',
  'OPTIONS',
])

export interface ProxyFetchOptions {
  account: Pick<ExternalAccount, 'id' | 'url' | 'authMode'>
  /** The app's authenticated `fetch` (bearer token); its login failure is already a `DavError`. */
  fetch: typeof fetch
  /** The sealed credential this browser has for the account. */
  sealed: () => string | null
  /** Called when the proxy says the sealed credential is void (428), before the error is thrown. */
  onCredentialVoid?: () => void
}

/** The origin an account's credential is bound to; throws for an address that has none. */
export function accountOrigin(accountUrl: string): string {
  const url = new URL(accountUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('an external account needs an http(s) address')
  }
  return url.origin
}

/**
 * `url` as a URL of the account's server, or a refusal. Relative references are read against the
 * account's address (so `//other.example/x` becomes a URL of `other.example` and is refused).
 */
export function resolveAccountUrl(accountUrl: string, input: string | URL): URL {
  let url: URL
  try {
    url = new URL(input, accountUrl)
  } catch {
    throw new DavError('bad-response', 'the request URL is not valid')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== accountOrigin(accountUrl) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new DavError('bad-response', 'the request is not for the account’s server')
  }
  return url
}

/** `/api/external/<id><path><query>` for a URL of the account's server. */
export function proxyUrl(accountId: number, url: URL): string {
  return `${EXTERNAL_PROXY_PREFIX}/${accountId}${url.pathname}${url.search}`
}

/** What the proxy puts in the `error` / `data.code` / `data.reason` of its own JSON errors. */
const PROXY_CODES: Record<string, DavErrorKind> = {
  credential_required: 'credential-needed',
  upstream_login_failed: 'login-rejected',
  host_not_allowed: 'host-not-allowed',
  rate_limited: 'rate-limited',
  account_not_found: 'not-found',
  unreachable: 'network',
  timeout: 'network',
  redirect_refused: 'network',
  too_large: 'bad-response',
  bad_response: 'bad-response',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The code of a proxy error body, wherever the project's JSON shape puts it. */
function codeOf(body: unknown): string | null {
  if (!isRecord(body)) return null
  const data = isRecord(body.data) ? body.data : {}
  for (const candidate of [data.code, data.reason, body.code, body.reason, body.error]) {
    if (typeof candidate === 'string' && candidate in PROXY_CODES) return candidate
  }
  return null
}

function kindForProxyStatus(status: number): DavErrorKind | null {
  switch (status) {
    case 428:
      return 'credential-needed'
    case 403:
      return 'host-not-allowed'
    case 404:
      return 'not-found'
    case 429:
      return 'rate-limited'
    case 502:
    case 503:
    case 504:
      return 'network'
    default:
      return null
  }
}

/**
 * The error for an answer that is not the account server's own, or null to hand the answer on.
 * Every answer of the account's server carries `X-Upstream-Status`; one without it came from the
 * proxy itself. A 401 of the proxy route is the app's own token (the app's `fetch` has renewed it
 * once already); an upstream 401 arrives as 502 with `X-Upstream-Status: 401`.
 */
async function failureOf(response: Response): Promise<DavError | null> {
  const { status } = response
  if (status === 401) {
    return new DavError('unauthorized', 'the app’s sign-in was refused', { status })
  }
  const upstream = response.headers.get('X-Upstream-Status')
  if (upstream !== null) {
    return status === 502 && upstream.trim() === '401'
      ? new DavError('login-rejected', 'the account’s server refused the login', { status })
      : null
  }
  if (response.ok) return null

  let body: unknown = null
  if (response.headers.get('content-type')?.toLowerCase().includes('json')) {
    try {
      body = await response.json()
    } catch {
      // not JSON after all; the status decides
    }
  }
  const code = codeOf(body)
  const kind = (code === null ? null : PROXY_CODES[code]) ?? kindForProxyStatus(status)
  return kind === null
    ? errorForStatus('proxy', status)
    : new DavError(kind, `the proxy answered HTTP ${status}${code ? ` (${code})` : ''}`, { status })
}

export function createProxyFetch(options: ProxyFetchOptions): typeof fetch {
  const { account } = options
  // Fails now, not at the first request, for an address that has no origin.
  accountOrigin(account.url)

  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new TypeError('the account’s fetch takes a URL, not a Request')
    }
    const target = resolveAccountUrl(account.url, input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (!PROXY_METHODS.has(method)) {
      throw new DavError('forbidden', `${method} is not allowed: external calendars are read-only`)
    }

    // Whatever the caller put in these two is dropped: the app's token is added further down, and
    // the credential is the account's alone.
    const headers = new Headers(init?.headers)
    headers.delete('Authorization')
    headers.delete(EXTERNAL_CREDENTIAL_HEADER)
    if (account.authMode === 'basic') {
      const sealed = options.sealed()
      if (!sealed) throw new DavError('credential-needed', 'there is no password for the account')
      headers.set(EXTERNAL_CREDENTIAL_HEADER, `Sealed ${sealed}`)
    }

    const response = await options.fetch(proxyUrl(account.id, target), { ...init, method, headers })
    const failure = await failureOf(response)
    if (failure === null) return response
    // The body of an error is of no use to the caller; release the connection.
    await response.body?.cancel().catch(() => undefined)
    if (failure.kind === 'credential-needed') options.onCredentialVoid?.()
    throw failure
  }
}
