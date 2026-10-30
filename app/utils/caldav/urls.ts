// URL and ETag handling for the CalDAV transport. Hrefs from a server come as paths or absolute
// URLs; callers keep the form the server gave, requests need an absolute URL. The injected `fetch`
// carries the user's credentials, so a URL that leaves the server's origin must never be requested.
import { DavError } from './errors'

/** The server's base URL as a `URL`; a bare path is read against the page's origin. */
export function parseBaseUrl(baseUrl: string): URL {
  let url: URL | undefined
  try {
    if (baseUrl.startsWith('/') && typeof location !== 'undefined') {
      url = new URL(baseUrl, location.origin)
    } else {
      url = new URL(baseUrl)
    }
  } catch {
    // handled below
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new TypeError(`CalDAV baseUrl must be an absolute http(s) URL: ${baseUrl}`)
  }
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/**
 * The absolute URL to request for `href`, resolved against `relativeTo` (default: the base URL).
 * Anything that is not http(s) on the server's own origin, or that carries credentials, is
 * refused: hrefs come from the server's answers, and a hostile one must not receive the token.
 */
export function resolveRequestUrl(href: string, base: URL, relativeTo?: string): string {
  let url: URL
  try {
    url = new URL(href, relativeTo ?? base)
  } catch {
    throw new DavError('bad-response', 'the server sent an href that is not a URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== base.origin ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new DavError('bad-response', 'the href is not on the CalDAV server’s origin')
  }
  url.hash = ''
  return url.href
}

/** `/path?query` of an absolute URL; anything else is returned unchanged. */
export function toDavPath(href: string): string {
  if (!/^https?:\/\//i.test(href)) return href
  try {
    const url = new URL(href)
    return `${url.pathname}${url.search}`
  } catch {
    return href
  }
}

/**
 * An href in the form to hand to callers: absolute URLs and paths stay as the server gave them
 * (trimmed), a relative reference becomes a path resolved against the request it answered.
 */
export function hrefForCaller(href: string, requestUrl: string): string {
  const trimmed = href.trim()
  // Anything with a scheme is not a reference to resolve (`javascript:` must stay recognisable).
  if (trimmed.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed, requestUrl)
    return `${url.pathname}${url.search}`
  } catch {
    return trimmed
  }
}

export function ensureTrailingSlash(href: string): string {
  const queryAt = href.search(/[?#]/)
  const path = queryAt === -1 ? href : href.slice(0, queryAt)
  const rest = queryAt === -1 ? '' : href.slice(queryAt)
  return `${path.endsWith('/') ? path : `${path}/`}${rest}`
}

/**
 * A key under which two spellings of one resource agree: the path only (a different host cannot
 * be another resource of this server), percent-encoding normalized, no trailing slash.
 */
export function resourceKey(href: string): string {
  const path = toDavPath(href).replace(/[?#].*$/, '')
  const normalized = path
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment))
      } catch {
        return segment
      }
    })
    .join('/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * An entity tag as the quoted string a server sends and expects back in `If-Match`. A weak `W/`
 * prefix is dropped (`If-Match` compares strongly, so a weak tag could never match), an unquoted
 * tag is quoted, and anything empty or containing control characters is no tag.
 */
export function normalizeEtag(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  let tag = value.trim()
  if (/^W\//i.test(tag)) tag = tag.slice(2).trim()
  if (tag === '' || tag === '""' || hasControlChars(tag)) return null
  return tag.startsWith('"') ? tag : `"${tag}"`
}

/** The tag for an `If-Match` header; a tag the caller passed that is unusable is a bug, not a no-op. */
export function requireEtag(etag: string): string {
  const tag = normalizeEtag(etag)
  if (tag === null) throw new TypeError('the entity tag is empty or malformed')
  return tag
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as `#rrggbb` (lower case); anything else is no colour. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1]
  if (!hex) return null
  if (hex.length === 3) {
    return `#${hex
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`
  }
  return `#${hex.slice(0, 6).toLowerCase()}`
}

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** True when `text` has a control character (C0 or DEL). */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** True when `text` has a character XML 1.0 cannot carry: control characters other than tab, LF, CR. */
export function hasXmlForbiddenChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return true
    }
  }
  return false
}
