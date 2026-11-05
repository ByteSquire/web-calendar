import { isValidSubject } from '../auth/subject'
import { sharingFail, type RadicaleShare, type SharingResult } from './types'

// The sharing writer's own Radicale client. It is the one component that sends an identity it did
// not verify, so it is separate from the gateway, never reachable through /caldav/, and refuses any
// principal that is not a valid subject (or the service principal). No redirects are followed.

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const SHARING_API = '/.sharing/v1'
/** The Apple/Radicale namespace of `calendar-color`, as the app's CalDAV client writes it. */
const ICAL_NS = 'http://apple.com/ns/ical/'

export type ShareType = 'map' | 'token'

export interface RadicaleClientOptions {
  /** Internal URL of Radicale (`radicale.url`). */
  baseUrl: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface NewShare {
  pathMapped: string
  pathOrToken: string
  user: string
  permissions: string
}

export interface RadicaleClient {
  listShares(owner: string, type: ShareType): Promise<SharingResult<RadicaleShare[]>>
  createShare(owner: string, share: NewShare): Promise<SharingResult<void>>
  deleteShare(owner: string, type: ShareType, pathOrToken: string): Promise<SharingResult<void>>
  /** What a user share needs before it is live: the member enables and unhides it. */
  acceptShare(member: string, pathOrToken: string): Promise<SharingResult<void>>
  /** PROPFIND; the multistatus text. */
  propfind(principal: string, path: string, depth: 0 | 1): Promise<SharingResult<string>>
  /** MKCALENDAR; an existing collection is not an error. */
  makeCalendar(
    principal: string,
    path: string,
    displayName: string,
    color?: string,
  ): Promise<SharingResult<void>>
  /** PROPPATCH of the display name (`D:displayname`). */
  setDisplayName(principal: string, path: string, displayName: string): Promise<SharingResult<void>>
  /** PROPPATCH of the colour (`ICAL:calendar-color`), `#rrggbb`. */
  setColor(principal: string, path: string, color: string): Promise<SharingResult<void>>
  /** PROPPATCH remove of the colour: the calendar has no colour afterwards. */
  clearColor(principal: string, path: string): Promise<SharingResult<void>>
  /** DELETE of a whole collection; a missing one is not an error. */
  deleteCollection(principal: string, path: string): Promise<SharingResult<void>>
  putObject(principal: string, path: string, ics: string): Promise<SharingResult<void>>
  /** A missing object is not an error. */
  deleteObject(principal: string, path: string): Promise<SharingResult<void>>
}

/** Text for an XML element: the characters that would end it or open markup are dropped. */
export function xmlSafeText(text: string): string {
  return text.replace(/[<>&"']/g, '')
}

/**
 * The principals the client may act as: a valid subject, never anything else. That includes the
 * app's own service principals (`_resources`, `_group-<id>`, the shared owners), which have the shape.
 */
export function isActingPrincipal(principal: unknown): principal is string {
  return isValidSubject(principal)
}

/** A path in the store: `/a/b/` or `/a/b/c.ics`, segments encoded, no dot segments. */
function isStorePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('//') || path.includes('?') || path.includes('#')) {
    return false
  }
  return path.split('/').every((segment) => segment !== '.' && segment !== '..')
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

function parseShares(text: string, owner: string): SharingResult<RadicaleShare[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return sharingFail('malformed', 'the share list is not JSON')
  }
  const content =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).Content
      : undefined
  if (!Array.isArray(content))
    return sharingFail('malformed', 'the share list has no Content array')
  const shares: RadicaleShare[] = []
  for (const item of content) {
    const row = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    // A member's list also holds the shares mapped to them, which only their owner may change.
    const rowOwner = stringField(row, 'Owner')
    if (rowOwner !== null && rowOwner !== owner) continue
    const pathMapped = stringField(row, 'PathMapped')
    const pathOrToken = stringField(row, 'PathOrToken')
    const user = stringField(row, 'User')
    const permissions = stringField(row, 'Permissions')
    if (pathMapped === null || pathOrToken === null || user === null || permissions === null) {
      return sharingFail('malformed', 'a share in the list lacks a field')
    }
    shares.push({
      pathMapped,
      pathOrToken,
      user,
      permissions,
      // Radicale 3.9 lists four flags; a share is live for the member only if nobody switched it off.
      enabled: row.EnabledByOwner !== false && row.EnabledByUser !== false,
      hidden: row.HiddenByOwner === true || row.HiddenByUser === true,
    })
  }
  return { ok: true, value: shares }
}

async function readCapped(response: Response, max: number): Promise<SharingResult<string>> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > max) {
    await response.body?.cancel().catch(() => undefined)
    return sharingFail('too-large', 'the response is too large')
  }
  if (!response.body) return { ok: true, value: '' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return sharingFail('too-large', 'the response is too large')
    }
    chunks.push(value)
  }
  return { ok: true, value: Buffer.concat(chunks).toString('utf8') }
}

export function createRadicaleClient(options: RadicaleClientOptions): RadicaleClient {
  const base = new URL(options.baseUrl).href.replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

  async function send(
    principal: string,
    method: string,
    path: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<SharingResult<{ status: number; text: string }>> {
    if (!isActingPrincipal(principal)) {
      return sharingFail('invalid-principal', 'refusing to act as an invalid principal')
    }
    if (!isStorePath(path)) return sharingFail('invalid-principal', 'refusing an invalid path')
    let response: Response
    try {
      response = await doFetch(base + path, {
        method,
        headers: { ...init.headers, 'x-remote-user': principal },
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // The cause can name the URL only; there is no secret in it, but nothing useful either.
      return sharingFail('unreachable', `${method} to Radicale failed`)
    }
    const text = await readCapped(response, maxBytes).catch(() =>
      sharingFail('unreachable', 'reading the Radicale answer failed'),
    )
    if (!text.ok) return text
    if (response.status >= 500) {
      return sharingFail('unreachable', `Radicale answered ${response.status}`, response.status)
    }
    if (response.status >= 300 && response.status < 400) {
      return sharingFail('rejected', `Radicale redirected (${response.status})`, response.status)
    }
    return { ok: true, value: { status: response.status, text: text.value } }
  }

  async function api(
    principal: string,
    type: ShareType,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<SharingResult<string>> {
    const result = await send(principal, 'POST', `${SHARING_API}/${type}/${action}`, {
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    if (!result.ok) return result
    if (result.value.status !== 200) {
      return sharingFail(
        'rejected',
        `${type}/${action} answered ${result.value.status}`,
        result.value.status,
      )
    }
    return { ok: true, value: result.value.text }
  }

  const ok: SharingResult<void> = { ok: true, value: undefined }

  /**
   * PROPPATCH with one `set` of the given properties. Radicale answers 207 with one propstat per
   * property; any of them that is not 200 means the property was refused, so that is a failure.
   */
  async function proppatch(
    principal: string,
    path: string,
    props: string,
    op: 'set' | 'remove' = 'set',
  ): Promise<SharingResult<void>> {
    const body =
      `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:ICAL="${ICAL_NS}">` +
      `<D:${op}><D:prop>${props}</D:prop></D:${op}></D:propertyupdate>`
    const result = await send(principal, 'PROPPATCH', path, {
      body,
      headers: { 'content-type': 'application/xml' },
    })
    if (!result.ok) return result
    const { status, text } = result.value
    if (status !== 207 && status !== 200) {
      return sharingFail('rejected', `PROPPATCH answered ${status}`, status)
    }
    if (/HTTP\/1\.1 (?!200)\d{3}/.test(text)) {
      return sharingFail('rejected', 'PROPPATCH refused a property')
    }
    return ok
  }

  return {
    async listShares(owner, type) {
      const result = await api(owner, type, 'list', {})
      return result.ok ? parseShares(result.value, owner) : result
    },
    async createShare(owner, share) {
      const result = await api(owner, 'map', 'create', {
        PathMapped: share.pathMapped,
        PathOrToken: share.pathOrToken,
        User: share.user,
        Permissions: share.permissions,
        Enabled: true,
        Hidden: false,
      })
      return result.ok ? ok : result
    },
    async deleteShare(owner, type, pathOrToken) {
      const result = await api(owner, type, 'delete', { PathOrToken: pathOrToken })
      // 404 means it is gone already (or, for tokens, that Radicale has token shares switched off).
      if (!result.ok && result.failure.status === 404) return ok
      return result.ok ? ok : result
    },
    async acceptShare(member, pathOrToken) {
      for (const action of ['enable', 'unhide']) {
        const result = await api(member, 'map', action, { PathOrToken: pathOrToken })
        if (!result.ok) return result
      }
      return ok
    },
    async propfind(principal, path, depth) {
      const body =
        '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/></D:prop></D:propfind>'
      const result = await send(principal, 'PROPFIND', path, {
        body,
        headers: { depth: String(depth), 'content-type': 'application/xml' },
      })
      if (!result.ok) return result
      if (result.value.status !== 207) {
        return sharingFail(
          'rejected',
          `PROPFIND answered ${result.value.status}`,
          result.value.status,
        )
      }
      return { ok: true, value: result.value.text }
    },
    async makeCalendar(principal, path, displayName, color) {
      const name = xmlSafeText(displayName)
      const colour =
        color === undefined ? '' : `<ICAL:calendar-color>${color}</ICAL:calendar-color>`
      const body =
        '<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"' +
        ` xmlns:ICAL="${ICAL_NS}">` +
        `<D:set><D:prop><D:displayname>${name}</D:displayname>${colour}` +
        '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' +
        '</D:prop></D:set></C:mkcalendar>'
      const result = await send(principal, 'MKCALENDAR', path, {
        body,
        headers: { 'content-type': 'application/xml' },
      })
      if (!result.ok) return result
      const { status } = result.value
      // 405 or 409 is how a server says the collection exists already.
      if (status === 201 || status === 405 || status === 409) return ok
      return sharingFail('rejected', `MKCALENDAR answered ${status}`, status)
    },
    setDisplayName(principal, path, displayName) {
      return proppatch(
        principal,
        path,
        `<D:displayname>${xmlSafeText(displayName)}</D:displayname>`,
      )
    },
    setColor(principal, path, color) {
      return proppatch(principal, path, `<ICAL:calendar-color>${color}</ICAL:calendar-color>`)
    },
    clearColor(principal, path) {
      return proppatch(principal, path, '<ICAL:calendar-color/>', 'remove')
    },
    async deleteCollection(principal, path) {
      const result = await send(principal, 'DELETE', path)
      if (!result.ok) return result
      const { status } = result.value
      if (status === 200 || status === 204 || status === 404) return ok
      return sharingFail('rejected', `DELETE answered ${status}`, status)
    },
    async putObject(principal, path, ics) {
      const result = await send(principal, 'PUT', path, {
        body: ics,
        headers: { 'content-type': 'text/calendar; charset=utf-8' },
      })
      if (!result.ok) return result
      const { status } = result.value
      if (status === 201 || status === 204) return ok
      return sharingFail('rejected', `PUT answered ${status}`, status)
    },
    async deleteObject(principal, path) {
      const result = await send(principal, 'DELETE', path)
      if (!result.ok) return result
      const { status } = result.value
      if (status === 200 || status === 204 || status === 404) return ok
      return sharingFail('rejected', `DELETE answered ${status}`, status)
    },
  }
}
