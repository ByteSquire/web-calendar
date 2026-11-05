// CalDAV transport for the SPA: discovery, calendar listing, time-range reads, conditional writes.
//
// tsdav does the HTTP and the multistatus parsing (`davRequest`), nothing else: its helpers
// (`createAccount`, `fetchCalendars`, `fetchCalendarObjects`) take extra requests, follow
// `.well-known` redirects a browser cannot see, filter hrefs by file extension, rewrite hrefs to
// absolute URLs and throw plain `Error`s without a status. So the request bodies are written here,
// every answer is checked here, and the iCalendar text passes through untouched (it is parsed and
// patched elsewhere, with ical.js).
//
// ALL requests go through the injected `fetch` (token renewal, abort signals and tests live there).
// tsdav binds the global `fetch` when it loads and would silently use it if one call forgot to pass
// ours, so every tsdav call goes through `xml()` below, the single place that passes it.
import { davRequest } from 'tsdav'
import type { DAVResponse } from 'tsdav'
import { DavError, errorForStatus, errorFromThrown } from './errors'
import { createFlights } from './flights'
import type { DavCalendar, DavObject, DavRange } from './types'
import {
  ensureTrailingSlash,
  hasXmlForbiddenChars,
  hrefForCaller,
  normalizeColor,
  normalizeEtag,
  parseBaseUrl,
  requireEtag,
  resolveRequestUrl,
  resourceKey,
  toDavPath,
  xmlEscape,
} from './urls'
import { asArray, hrefIn, isRecord, isWellFormedXml, localKeys, prop, textOf } from './xml'

export interface CalDavClientOptions {
  /** `<origin>/caldav` for the built-in service. */
  baseUrl: string
  /** Adds the credentials; the only way requests leave this module. */
  fetch: typeof fetch
  /** Clock for the discovery cache (tests). */
  now?: () => number
  /** How long a discovery result is reused. Default 5 minutes. */
  discoveryTtlMs?: number
}

export interface CalDavClient {
  /** The user's principal and calendar home, as hrefs in the server's form. Cached for a few minutes. */
  discover(signal?: AbortSignal): Promise<{ principalUrl: string; homeUrl: string }>
  /** Forget the cached discovery (after a login change or an error that looks like a moved home). */
  clearDiscovery(): void
  /** The calendars in the home set that can hold events. */
  listCalendars(signal?: AbortSignal): Promise<DavCalendar[]>
  /**
   * The events in `range` of one calendar, one request (a second only if the server leaves out
   * `calendar-data`). With `expand` the server expands recurrences into instances. The range is
   * sent as UTC instants; Radicale reads floating and all-day times as if they were UTC, so callers
   * pad it and filter by the true range themselves.
   */
  fetchObjects(
    calendarUrl: string,
    range: DavRange,
    options?: { expand?: boolean; signal?: AbortSignal },
  ): Promise<DavObject[]>
  /**
   * The busy times in `range` of one calendar (a `free-busy-query`, RFC 4791 §7.10): the server's
   * VFREEBUSY text, all a free/busy share may read. Padded like `fetchObjects` by the caller.
   */
  fetchFreeBusy(
    calendarUrl: string,
    range: DavRange,
    options?: { signal?: AbortSignal },
  ): Promise<string>
  getObject(objectUrl: string, signal?: AbortSignal): Promise<DavObject>
  /**
   * Writes an object. `etag` becomes `If-Match` (a `conflict` error if it changed meanwhile);
   * `create` becomes `If-None-Match: *` (an `exists` error if something is there). Without either
   * the write is unconditional. Returns the new ETag.
   */
  putObject(args: {
    url: string
    data: string
    etag?: string
    create?: boolean
    signal?: AbortSignal
  }): Promise<{ url: string; etag: string }>
  deleteObject(url: string, etag?: string, signal?: AbortSignal): Promise<void>
  /** MKCALENDAR for events in the home set. `slug` (default: a random UUID) is the path segment. */
  createCalendar(args: {
    displayName: string
    color?: string
    slug?: string
    signal?: AbortSignal
  }): Promise<DavCalendar>
}

interface Discovery {
  principalUrl: string
  homeUrl: string
}

const DEFAULT_DISCOVERY_TTL_MS = 5 * 60_000
const NAMESPACES =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:ca="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"'
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

function propfindBody(props: string[]): string {
  return `${XML_HEAD}<d:propfind ${NAMESPACES}><d:prop>${props.map((p) => `<${p}/>`).join('')}</d:prop></d:propfind>`
}

/** `20261105T100000Z`; the start rounds down and the end up, so the range never shrinks. */
function icalUtc(date: Date, round: 'floor' | 'ceil'): string {
  const ms = date.getTime()
  const seconds = (round === 'floor' ? Math.floor(ms / 1000) : Math.ceil(ms / 1000)) * 1000
  const rounded = new Date(seconds)
  if (
    !Number.isFinite(seconds) ||
    rounded.getUTCFullYear() < 1 ||
    rounded.getUTCFullYear() > 9999
  ) {
    throw new RangeError('the time range needs valid dates between the years 1 and 9999')
  }
  return rounded
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

function randomSlug(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function lastSegment(href: string): string {
  const segment = resourceKey(href).split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Only a `multistatus` body counts; any other answer is an HTTP error or not CalDAV at all. */
function multistatus(responses: DAVResponse[], method: string): DAVResponse[] {
  const first = responses[0]
  if (first?.parseError !== undefined) {
    throw new DavError('bad-response', `${method}: the answer is not well-formed XML`, {
      status: first.status,
    })
  }
  const raw: unknown = first?.raw
  if (isRecord(raw) && 'multistatus' in raw) {
    // An empty <multistatus/> comes back as one entry without an href.
    return responses.filter((r) => typeof r.href === 'string' && r.href.trim() !== '')
  }
  if (first && first.status >= 400) throw errorForStatus(method, first.status)
  throw new DavError('bad-response', `${method}: expected a multistatus answer`, {
    ...(first ? { status: first.status } : {}),
  })
}

function privilegeNames(props: DAVResponse['props']): Set<string> | null {
  const set = prop(props, 'currentUserPrivilegeSet')
  if (set === undefined) return null
  const names = new Set<string>()
  for (const privilege of asArray(isRecord(set) ? set.privilege : undefined)) {
    if (isRecord(privilege)) for (const name of localKeys(privilege)) names.add(name)
  }
  return names
}

function calendarOf(
  response: DAVResponse,
  requestUrl: string,
  usable: (href: string) => boolean,
): DavCalendar | null {
  if (!response.ok || !response.href || !usable(response.href)) return null
  const props = response.props
  const types = prop(props, 'resourcetype')
  if (!isRecord(types) || !localKeys(types).includes('calendar')) return null

  const set = prop(props, 'supportedCalendarComponentSet')
  const components = asArray(isRecord(set) ? set.comp : undefined)
    .map((comp) => (isRecord(comp) && isRecord(comp._attributes) ? comp._attributes.name : null))
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.toUpperCase())
  if (components.length > 0 && !components.includes('VEVENT')) return null

  const url = ensureTrailingSlash(hrefForCaller(response.href, requestUrl))
  const privileges = privilegeNames(props)
  const canWrite =
    privileges === null ||
    privileges.has('all') ||
    privileges.has('write') ||
    privileges.has('writeContent') ||
    privileges.has('bind')
  // Radicale lists `read-free-busy` alone for a free/busy share (`f`), with `read` for any other.
  const freeBusyOnly =
    privileges !== null &&
    (privileges.has('readFreeBusy') || privileges.has('read-free-busy')) &&
    !privileges.has('read') &&
    !privileges.has('all')
  return {
    url,
    displayName: textOf(prop(props, 'displayname')) || lastSegment(url),
    color: normalizeColor(textOf(prop(props, 'calendarColor'))),
    ctag: textOf(prop(props, 'getctag')) || null,
    components,
    readOnly: !canWrite || freeBusyOnly,
    freeBusyOnly,
  }
}

export function createCalDavClient(options: CalDavClientOptions): CalDavClient {
  const base = parseBaseUrl(options.baseUrl)
  const doFetch = options.fetch
  const now = options.now ?? Date.now
  const discoveryTtlMs = options.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS

  /** Maps whatever the block throws (including a body read cut short by an abort) to a DavError. */
  async function guarded<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw errorFromThrown(signal.reason, signal)
    try {
      return await work()
    } catch (error) {
      throw errorFromThrown(error, signal)
    }
  }

  const requestUrl = (href: string, relativeTo?: string) =>
    resolveRequestUrl(href, base, relativeTo)

  /**
   * Whether `href` (from a server answer) is one this client may ever request. A foreign-origin
   * entry is left out of the results instead of failing them: nothing is sent to it, and the
   * other entries stay usable.
   */
  const usable = (href: string, relativeTo: string) => {
    try {
      requestUrl(href, relativeTo)
      return true
    } catch {
      return false
    }
  }

  /**
   * `fetch` for tsdav: the injected one, plus a check that an XML answer is well-formed (tsdav's
   * parser swallows XML errors, so a cut-off body would read as a shorter list).
   */
  const checkedFetch: typeof fetch = async (input, init) => {
    const response = await doFetch(input, init)
    const type = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!response.ok || !type.includes('xml')) return response
    const text = await response.text()
    if (text !== '' && !isWellFormedXml(text)) {
      throw new DavError('bad-response', 'the answer is not well-formed XML', {
        status: response.status,
      })
    }
    return new Response(text === '' ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  /** A WebDAV request with an XML body; the single place that hands tsdav a `fetch`. */
  function xml(
    method: 'PROPFIND' | 'REPORT' | 'MKCALENDAR',
    url: string,
    body: string,
    depth: '0' | '1' | undefined,
    signal?: AbortSignal,
  ): Promise<DAVResponse[]> {
    return guarded(signal, () =>
      davRequest({
        url,
        init: { method, headers: depth ? { Depth: depth } : {}, body },
        convertIncoming: false,
        fetchOptions: signal ? { signal } : {},
        fetch: checkedFetch,
      }),
    )
  }

  /** A plain HTTP request (GET, PUT, DELETE); the body is read inside the guard. */
  function plain(
    method: 'GET' | 'PUT' | 'DELETE' | 'REPORT',
    url: string,
    init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ status: number; etag: string | null; text: string }> {
    return guarded(init.signal, async () => {
      const response = await doFetch(url, {
        method,
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(method === 'GET' ? { cache: 'no-store' as const } : {}),
      })
      const text = await response.text()
      return { status: response.status, etag: normalizeEtag(response.headers.get('etag')), text }
    })
  }

  // --- discovery ----------------------------------------------------------------------------

  let discovered: { value: Discovery; expires: number } | null = null
  let discoveryEpoch = 0
  const discoveryFlights = createFlights<Discovery>()

  async function discoverNow(signal: AbortSignal): Promise<Discovery> {
    const principalAnswer = multistatus(
      await xml('PROPFIND', base.href, propfindBody(['d:current-user-principal']), '0', signal),
      'PROPFIND',
    )
    const principalHref = principalAnswer
      .map((r) => hrefIn(prop(r.props, 'currentUserPrincipal')))
      .find((href) => href !== null)
    if (!principalHref) {
      throw new DavError('bad-response', 'the server names no current-user-principal')
    }
    const principalUrl = hrefForCaller(principalHref, base.href)

    const homeAnswer = multistatus(
      await xml(
        'PROPFIND',
        requestUrl(principalUrl, base.href),
        propfindBody(['c:calendar-home-set']),
        '0',
        signal,
      ),
      'PROPFIND',
    )
    const homeHref = homeAnswer
      .map((r) => hrefIn(prop(r.props, 'calendarHomeSet')))
      .find((href) => href !== null)
    if (!homeHref) throw new DavError('bad-response', 'the server names no calendar-home-set')
    return { principalUrl, homeUrl: ensureTrailingSlash(hrefForCaller(homeHref, base.href)) }
  }

  async function discover(signal?: AbortSignal): Promise<Discovery> {
    if (discovered && now() < discovered.expires) return discovered.value
    const epoch = discoveryEpoch
    // The shared request has its own signal, so one caller giving up does not fail the others.
    return discoveryFlights.join(
      'discover',
      async (shared) => {
        const value = await discoverNow(shared)
        if (epoch === discoveryEpoch) discovered = { value, expires: now() + discoveryTtlMs }
        return value
      },
      signal ? { signal } : {},
    )
  }

  function clearDiscovery(): void {
    discovered = null
    discoveryEpoch++
    discoveryFlights.drop('')
  }

  // --- reads --------------------------------------------------------------------------------

  async function listCalendars(signal?: AbortSignal): Promise<DavCalendar[]> {
    const { homeUrl } = await discover(signal)
    const url = requestUrl(homeUrl)
    const answer = multistatus(
      await xml(
        'PROPFIND',
        url,
        propfindBody([
          'd:displayname',
          'd:resourcetype',
          'ca:calendar-color',
          'cs:getctag',
          'c:supported-calendar-component-set',
          'd:current-user-privilege-set',
        ]),
        '1',
        signal,
      ),
      'PROPFIND',
    )
    return answer.flatMap((response) => calendarOf(response, url, (h) => usable(h, url)) ?? [])
  }

  function dataProps(expand: { start: string; end: string } | null): string {
    const expandElement = expand ? `<c:expand start="${expand.start}" end="${expand.end}"/>` : ''
    return `<d:prop><d:getetag/><c:calendar-data>${expandElement}</c:calendar-data></d:prop>`
  }

  async function fetchObjects(
    calendarUrl: string,
    range: DavRange,
    opts: { expand?: boolean; signal?: AbortSignal } = {},
  ): Promise<DavObject[]> {
    const url = requestUrl(calendarUrl)
    const start = icalUtc(range.start, 'floor')
    const end = icalUtc(range.end, 'ceil')
    if (start >= end) throw new RangeError('the time range is empty')
    const expand = opts.expand ? { start, end } : null
    const { signal } = opts

    const query =
      `${XML_HEAD}<c:calendar-query ${NAMESPACES}>${dataProps(expand)}` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter>` +
      `</c:calendar-query>`
    const answer = multistatus(await xml('REPORT', url, query, '1', signal), 'REPORT')

    const self = resourceKey(calendarUrl)
    const readable = (response: DAVResponse): response is DAVResponse & { href: string } =>
      response.ok &&
      typeof response.href === 'string' &&
      resourceKey(response.href) !== self &&
      usable(response.href, url)
    const toObject = (response: DAVResponse & { href: string }, data: string): DavObject => ({
      url: hrefForCaller(response.href, url),
      etag: normalizeEtag(textOf(prop(response.props, 'getetag'))) ?? '',
      data,
    })

    const objects: DavObject[] = []
    const withoutData: string[] = []
    for (const response of answer) {
      if (!readable(response)) continue
      const data = textOf(prop(response.props, 'calendarData'), { trim: false })
      if (data) objects.push(toObject(response, data))
      else withoutData.push(hrefForCaller(response.href, url))
    }
    if (withoutData.length === 0) return objects

    // A server that answers the query with etags only: fetch those objects in one multiget.
    const multiget =
      `${XML_HEAD}<c:calendar-multiget ${NAMESPACES}>${dataProps(expand)}` +
      `${withoutData.map((href) => `<d:href>${xmlEscape(toDavPath(href))}</d:href>`).join('')}` +
      `</c:calendar-multiget>`
    const fetched = multistatus(await xml('REPORT', url, multiget, '1', signal), 'REPORT')
    for (const response of fetched) {
      if (!readable(response)) continue
      const data = textOf(prop(response.props, 'calendarData'), { trim: false })
      // An object whose data the server will not give (free/busy-only access) is left out.
      if (data) objects.push(toObject(response, data))
    }
    return objects
  }

  async function fetchFreeBusy(
    calendarUrl: string,
    range: DavRange,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const url = requestUrl(calendarUrl)
    const start = icalUtc(range.start, 'floor')
    const end = icalUtc(range.end, 'ceil')
    if (start >= end) throw new RangeError('the time range is empty')
    const body =
      `${XML_HEAD}<c:free-busy-query ${NAMESPACES}>` +
      `<c:time-range start="${start}" end="${end}"/></c:free-busy-query>`
    const reply = await plain('REPORT', url, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (reply.status < 200 || reply.status >= 300) throw errorForStatus('REPORT', reply.status)
    if (!/^BEGIN:VCALENDAR/m.test(reply.text) || !/^BEGIN:VFREEBUSY/m.test(reply.text)) {
      throw new DavError('bad-response', 'REPORT: the answer is no VFREEBUSY', {
        status: reply.status,
      })
    }
    return reply.text
  }

  /** The ETag of one resource, for servers that leave the header out of a GET or PUT answer. */
  async function lookupEtag(url: string, signal?: AbortSignal): Promise<string | null> {
    const answer = multistatus(
      await xml('PROPFIND', url, propfindBody(['d:getetag']), '0', signal),
      'PROPFIND',
    )
    for (const response of answer) {
      const etag = normalizeEtag(textOf(prop(response.props, 'getetag')))
      if (etag) return etag
    }
    return null
  }

  async function getObject(objectUrl: string, signal?: AbortSignal): Promise<DavObject> {
    const url = requestUrl(objectUrl)
    const reply = await plain('GET', url, { headers: { Accept: 'text/calendar' }, signal })
    if (reply.status < 200 || reply.status >= 300) throw errorForStatus('GET', reply.status)
    const etag = reply.etag ?? (await lookupEtag(url, signal))
    if (!etag) throw new DavError('bad-response', 'GET: the server gives no ETag for the object')
    return { url: objectUrl, etag, data: reply.text }
  }

  // --- writes -------------------------------------------------------------------------------

  async function putObject(args: {
    url: string
    data: string
    etag?: string
    create?: boolean
    signal?: AbortSignal
  }): Promise<{ url: string; etag: string }> {
    if (args.create && args.etag !== undefined) {
      throw new TypeError('putObject: `create` and `etag` exclude each other')
    }
    const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' }
    if (args.create) headers['If-None-Match'] = '*'
    else if (args.etag !== undefined) headers['If-Match'] = requireEtag(args.etag)

    const url = requestUrl(args.url)
    const reply = await plain('PUT', url, { headers, body: args.data, signal: args.signal })
    if (reply.status < 200 || reply.status >= 300) {
      throw errorForStatus(
        'PUT',
        reply.status,
        reply.status === 412 && args.create ? 'exists' : undefined,
      )
    }
    if (reply.etag) return { url: args.url, etag: reply.etag }
    try {
      const etag = await lookupEtag(url, args.signal)
      if (etag) return { url: args.url, etag }
    } catch (error) {
      const failure = errorFromThrown(error, args.signal)
      if (failure.kind === 'aborted') throw failure
    }
    // Saved, but without a tag the next edit could not be conditional: let the caller reload.
    throw new DavError('bad-response', 'PUT: saved, but the new ETag could not be read')
  }

  async function deleteObject(url: string, etag?: string, signal?: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {}
    if (etag !== undefined) headers['If-Match'] = requireEtag(etag)
    const reply = await plain('DELETE', requestUrl(url), { headers, signal })
    if (reply.status < 200 || reply.status >= 300) throw errorForStatus('DELETE', reply.status)
  }

  async function createCalendar(args: {
    displayName: string
    color?: string
    slug?: string
    signal?: AbortSignal
  }): Promise<DavCalendar> {
    const displayName = args.displayName.trim()
    if (displayName === '' || hasXmlForbiddenChars(displayName)) {
      throw new TypeError('createCalendar: the display name is empty or has control characters')
    }
    const slug = args.slug ?? randomSlug()
    if (!SLUG.test(slug)) {
      throw new TypeError('createCalendar: the slug may only use a-z, 0-9 and "-"')
    }
    let color: string | null = null
    if (args.color !== undefined) {
      color = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(args.color) ? normalizeColor(args.color) : null
      if (color === null)
        throw new TypeError('createCalendar: the colour must be #RRGGBB or #RRGGBBAA')
    }

    const { homeUrl } = await discover(args.signal)
    const calendarUrl = `${ensureTrailingSlash(homeUrl)}${slug}/`
    const body =
      `${XML_HEAD}<c:mkcalendar ${NAMESPACES}><d:set><d:prop>` +
      `<d:displayname>${xmlEscape(displayName)}</d:displayname>` +
      `${color ? `<ca:calendar-color>${color}</ca:calendar-color>` : ''}` +
      `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
      `</d:prop></d:set></c:mkcalendar>`
    const [first] = await xml('MKCALENDAR', requestUrl(calendarUrl), body, undefined, args.signal)
    if (first?.parseError !== undefined) {
      throw new DavError('bad-response', 'MKCALENDAR: the answer is not well-formed XML')
    }
    if (!first) throw new DavError('bad-response', 'MKCALENDAR: no answer')
    // 405 is the RFC's "something is already there"; Radicale answers 409 for that.
    if (first.status >= 400) {
      throw errorForStatus(
        'MKCALENDAR',
        first.status,
        first.status === 405 || first.status === 409 ? 'exists' : undefined,
      )
    }
    if (first.status !== 200 && first.status !== 201) {
      throw new DavError('rejected', `MKCALENDAR: the server did not create the calendar`, {
        status: first.status,
      })
    }
    return {
      url: calendarUrl,
      displayName,
      color,
      ctag: null,
      components: ['VEVENT'],
      readOnly: false,
      freeBusyOnly: false,
    }
  }

  return {
    discover,
    clearDiscovery,
    listCalendars,
    fetchObjects,
    fetchFreeBusy,
    getObject,
    putObject,
    deleteObject,
    createCalendar,
  }
}
