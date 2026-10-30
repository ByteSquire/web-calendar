// Shared setup of the external-account tests: CalDAV answers as an account's server gives them, and
// a fake of the app's proxy (server/utils/external/proxy.ts) that wraps them the way the real one
// does: `X-Upstream-Status` on every answer of the account's server, the account's 401 as a 502
// `upstream_login_failed`, and its own failures as `{ "error": "<code>" }` without that header.
import type { ExternalAccount } from '../shared/types/external'

export const HOST = 'https://dav.example.org'

export function account(id: number, extra: Partial<ExternalAccount> = {}): ExternalAccount {
  return {
    id,
    name: `Account ${id}`,
    url: `${HOST}/dav/`,
    authMode: 'none',
    username: null,
    color: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...extra,
  }
}

export const SEALED = 'v1.AbCdEf0123456789_-.zyx'

// ---- CalDAV answers --------------------------------------------------------------------------

const NS =
  'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/"'
const XML = { 'content-type': 'text/xml; charset=utf-8' }

/** A 207 answer from the account's server. */
export const multistatus = (...responses: string[]) =>
  new Response(`<?xml version='1.0'?><multistatus ${NS}>${responses.join('')}</multistatus>`, {
    status: 207,
    headers: XML,
  })

export const entry = (href: string, props: string) =>
  `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`

export function calendarProps(
  name: string | null,
  options: { color?: string; components?: string[] } = {},
): string {
  const components = options.components ?? ['VEVENT']
  return (
    '<resourcetype><collection/><C:calendar/></resourcetype>' +
    (name === null ? '' : `<displayname>${name}</displayname>`) +
    (options.color ? `<A:calendar-color>${options.color}</A:calendar-color>` : '') +
    `<C:supported-calendar-component-set>${components
      .map((c) => `<C:comp name="${c}"/>`)
      .join('')}</C:supported-calendar-component-set>`
  )
}

export const folderProps = '<resourcetype><collection/></resourcetype>'
export const principalProps = (extra = '') =>
  `<resourcetype><collection/><principal/></resourcetype>${extra}`
export const homeSet = (href: string) =>
  `<C:calendar-home-set><href>${href}</href></C:calendar-home-set>`
export const currentPrincipal = (href: string) =>
  `<current-user-principal><href>${href}</href></current-user-principal>`

export const ICS = (uid: string, summary = 'Meeting', start = '20261028T090000Z') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:${summary}\r\nDTSTART:${start}\r\nDTEND:${start.replace('T09', 'T10')}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`

export const eventItem = (href: string, etag: string, data: string) =>
  entry(href, `<getetag>${etag}</getetag><C:calendar-data>${data}</C:calendar-data>`)

// ---- A fake of the proxy ---------------------------------------------------------------------

export interface UpstreamCall {
  accountId: number
  method: string
  /** The path and query on the account's server. */
  target: string
  path: string
  headers: Headers
  body: string
}

export type UpstreamHandler = (call: UpstreamCall) => Response | Promise<Response>

export interface ProxyCall extends UpstreamCall {
  /** The URL as the app's fetch received it. */
  url: string
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  })

/** Marks an answer as the proxy's own: `fakeProxy` hands it on without `X-Upstream-Status`. */
export const own = (response: Response): Response => {
  response.headers.set('x-proxy-own', '1')
  return response
}

/** The proxy's own failures: no `X-Upstream-Status`. */
export const ownError = {
  credentialRequired: () => own(json(428, { error: 'credential_required' })),
  hostNotAllowed: () => own(json(403, { error: 'host_not_allowed' })),
  accountNotFound: () => own(json(404, { error: 'account_not_found' })),
  rateLimited: () => own(json(429, { error: 'rate_limited' }, { 'retry-after': '3' })),
  unreachable: () => own(json(502, { error: 'unreachable' })),
  timeout: () => own(json(502, { error: 'timeout' })),
  tooLarge: () => own(json(502, { error: 'too_large' })),
  redirectRefused: () => own(json(502, { error: 'redirect_refused' })),
  /** The app's own token. */
  appToken: () => own(json(401, { statusCode: 401, message: 'Unauthorized' })),
}

/**
 * The app's `fetch` as seen by an account: requests to `/api/external/<id>…` are answered by
 * `upstream`, whose answer is wrapped like the real proxy does; an `ownError` is handed on as it is.
 */
export function fakeProxy(upstream: UpstreamHandler) {
  const calls: ProxyCall[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const match = /^\/api\/external\/(\d+)(\/.*)?$/.exec(url)
    if (!match) throw new Error(`not a proxy URL: ${url}`)
    const target = match[2] ?? '/'
    const call: ProxyCall = {
      url,
      accountId: Number(match[1]),
      method: init?.method ?? 'GET',
      target,
      path: target.replace(/\?.*$/, ''),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    const answer = await upstream(call)
    // Own failures were built without the header; the account's answers get it here.
    if (answer.headers.get('x-proxy-own') !== null) return answer
    if (answer.status === 401) {
      return json(502, { error: 'upstream_login_failed' }, { 'x-upstream-status': '401' })
    }
    const headers = new Headers(answer.headers)
    headers.set('x-upstream-status', String(answer.status))
    return new Response(answer.body, { status: answer.status, headers })
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}
