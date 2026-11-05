// Finding the calendars of an external account (FR-8). The address a user enters may be a calendar
// home (a folder of calendars), a principal (the user's entry in the server) or one calendar;
// nothing says which. Order:
//   1. PROPFIND the address (Depth 0). A calendar is the one calendar. A resource that names its
//      `calendar-home-set` is a principal: list that home.
//   2. Otherwise treat the address as a home and list it (Depth 1).
//   3. A home without calendars may be a server root: follow `current-user-principal` to
//      `calendar-home-set` and list that.
// Every href the server returns is pinned to the account's origin (`resolveRequestUrl`): a calendar
// on another host is left out, and a home on another host is an error, because nothing may be
// requested from, or sent to, a host the account was not made for. Requests go through `fetch`
// (the account's proxy adapter); tsdav is used for the multistatus parsing only, as in
// caldav/client.ts, whose small helpers are repeated here because they are private there.
import { davRequest } from 'tsdav'
import type { DAVResponse } from 'tsdav'
import { DavError, errorForStatus, errorFromThrown } from '../caldav/errors'
import type { DavCalendar } from '../caldav/types'
import {
  ensureTrailingSlash,
  normalizeColor,
  parseBaseUrl,
  resolveRequestUrl,
  resourceKey,
} from '../caldav/urls'
import { asArray, hrefIn, isRecord, isWellFormedXml, localKeys, prop, textOf } from '../caldav/xml'

export interface DiscoverOptions {
  /** The account's address: a calendar home, a principal or one calendar. */
  url: string
  /** The account's proxy `fetch`. */
  fetch: typeof fetch
  /** The name of a single calendar that has no `displayname`. */
  fallbackName: string
  signal?: AbortSignal
}

const NAMESPACES =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:ca="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"'
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'

const CALENDAR_PROPS = [
  'd:resourcetype',
  'd:displayname',
  'ca:calendar-color',
  'c:supported-calendar-component-set',
]

function propfindBody(props: string[]): string {
  return `${XML_HEAD}<d:propfind ${NAMESPACES}><d:prop>${props.map((p) => `<${p}/>`).join('')}</d:prop></d:propfind>`
}

/** Only a `multistatus` body counts; any other answer is an HTTP error or not CalDAV at all. */
function multistatus(responses: DAVResponse[]): DAVResponse[] {
  const first = responses[0]
  if (first?.parseError !== undefined) {
    throw new DavError('bad-response', 'PROPFIND: the answer is not well-formed XML', {
      status: first.status,
    })
  }
  const raw: unknown = first?.raw
  if (isRecord(raw) && 'multistatus' in raw) {
    // An empty <multistatus/> comes back as one entry without an href.
    return responses.filter((r) => typeof r.href === 'string' && r.href.trim() !== '')
  }
  if (first && first.status >= 400) throw errorForStatus('PROPFIND', first.status)
  throw new DavError('bad-response', 'PROPFIND: expected a multistatus answer', {
    ...(first ? { status: first.status } : {}),
  })
}

function isCalendar(response: DAVResponse): boolean {
  const types = prop(response.props, 'resourcetype')
  return isRecord(types) && localKeys(types).includes('calendar')
}

export async function discoverCalendars(options: DiscoverOptions): Promise<DavCalendar[]> {
  const { signal } = options
  const origin = new URL(options.url).origin
  const base = parseBaseUrl(origin)
  const start = resolveRequestUrl(options.url, base)

  /** `fetch` for tsdav, plus a check that an XML answer is well-formed (see caldav/client.ts). */
  const checkedFetch: typeof fetch = async (input, init) => {
    const response = await options.fetch(input, init)
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

  async function propfind(url: string, depth: '0' | '1', props: string[]): Promise<DAVResponse[]> {
    if (signal?.aborted) throw errorFromThrown(signal.reason, signal)
    try {
      return multistatus(
        await davRequest({
          url,
          init: { method: 'PROPFIND', headers: { Depth: depth }, body: propfindBody(props) },
          convertIncoming: false,
          fetchOptions: signal ? { signal } : {},
          fetch: checkedFetch,
        }),
      )
    } catch (error) {
      throw errorFromThrown(error, signal)
    }
  }

  /** `href` as an absolute URL of the account's server; null when it is not one. */
  function pinned(href: string, relativeTo: string): string | null {
    try {
      return ensureTrailingSlash(resolveRequestUrl(href, base, relativeTo))
    } catch {
      return null
    }
  }

  /** The calendar a response describes, if it is one that can hold events. */
  function calendarOf(response: DAVResponse, relativeTo: string): DavCalendar | null {
    if (!response.ok || !response.href || !isCalendar(response)) return null
    const url = pinned(response.href, relativeTo)
    if (url === null) return null

    const set = prop(response.props, 'supportedCalendarComponentSet')
    const components = asArray(isRecord(set) ? set.comp : undefined)
      .map((comp) => (isRecord(comp) && isRecord(comp._attributes) ? comp._attributes.name : null))
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.toUpperCase())
    if (components.length > 0 && !components.includes('VEVENT')) return null

    const last = resourceKey(url).split('/').filter(Boolean).pop() ?? ''
    let segment = last
    try {
      segment = decodeURIComponent(last)
    } catch {
      // keep the encoded segment
    }
    return {
      url,
      displayName: textOf(prop(response.props, 'displayname')) || segment,
      color: normalizeColor(textOf(prop(response.props, 'calendarColor'))),
      ctag: null,
      components,
      // Writing to external calendars is not supported yet.
      readOnly: true,
      // External calendars are read with their events only (the proxy has no free/busy query).
      freeBusyOnly: false,
    }
  }

  async function listHome(homeUrl: string): Promise<DavCalendar[]> {
    const answer = await propfind(homeUrl, '1', CALENDAR_PROPS)
    return answer.flatMap((response) => calendarOf(response, homeUrl) ?? [])
  }

  /** The `calendar-home-set` / `current-user-principal` href of a response, pinned or refused. */
  function namedUrl(response: DAVResponse | undefined, name: string, relativeTo: string) {
    const href = hrefIn(prop(response?.props, name))
    if (href === null) return null
    const url = pinned(href, relativeTo)
    if (url === null) {
      throw new DavError('bad-response', 'the server points to another host, which is not allowed')
    }
    return url
  }

  const sameResource = (a: string, b: string) => resourceKey(a) === resourceKey(b)

  const [here] = await propfind(start, '0', [
    ...CALENDAR_PROPS,
    'd:current-user-principal',
    'c:calendar-home-set',
  ])

  if (here && isCalendar(here)) {
    const calendar = calendarOf(here, start)
    if (calendar === null) return []
    // The address says which calendar the user means, whatever spelling the server answers with.
    const named = textOf(prop(here.props, 'displayname'))
    return [{ ...calendar, displayName: named || options.fallbackName }]
  }

  const homeUrl = namedUrl(here, 'calendarHomeSet', start)
  if (homeUrl !== null) return listHome(homeUrl)

  const children = await listHome(start)
  if (children.length > 0) return children

  const principalUrl = namedUrl(here, 'currentUserPrincipal', start)
  if (principalUrl === null || sameResource(principalUrl, start)) return []
  const [principal] = await propfind(principalUrl, '0', ['c:calendar-home-set'])
  const principalHome = namedUrl(principal, 'calendarHomeSet', principalUrl)
  return principalHome === null || sameResource(principalHome, start) ? [] : listHome(principalHome)
}
