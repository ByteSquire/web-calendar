// Where the app continues after the login. The value travels through the provider redirect (in the
// session storage), so it is checked when it is stored and again when it is read: an attacker must
// not be able to turn the callback page into an open redirect.

// Never send people back to the pages that finish or follow a login (a loop).
const AUTH_PATH = /^\/auth(\/|$)/
// Control characters (a tab or newline is dropped by URL parsers) and backslashes (read as `/`).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/
const DUMMY_ORIGIN = 'http://app.invalid'

/**
 * `value` if it is a same-origin relative reference (`/path?query#hash`), else `fallback`. The
 * result is normalised by the URL parser (dot segments, percent encoding).
 */
export function safeReturnTo(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value === '') return fallback
  // One leading slash, not followed by another slash: `//host` is a network-path reference.
  if (!value.startsWith('/') || value.startsWith('//') || FORBIDDEN.test(value)) return fallback
  let url: URL
  try {
    url = new URL(value, DUMMY_ORIGIN)
  } catch {
    return fallback
  }
  const result = url.pathname + url.search + url.hash
  // `/.//evil.com` normalises to `//evil.com`: check the result as well.
  if (url.origin !== DUMMY_ORIGIN || !result.startsWith('/') || result.startsWith('//'))
    return fallback
  if (AUTH_PATH.test(url.pathname)) return fallback
  return result
}
