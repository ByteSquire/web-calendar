// The part of a proxy URL after `/api/external/<id>`: the origin-relative path and query that are
// sent to the account's server. The ORIGIN is never taken from here (it comes from the account's
// row), so what is checked is only that this text cannot be read as anything but one path on that
// origin: no `..`, no way to start a new authority, no separator or control character smuggled in
// by a percent escape, nothing the proxy's own URL layers would read differently from the server.
//
// The text is read as the client wrote it, because `URL` would silently resolve `..` and `%2e%2e`,
// and it is forwarded as written (not re-encoded: `@` and `:` in a principal's href must stay
// what the server sent), so what was checked is exactly what is sent.

/** Longest path, and longest query, accepted. */
export const MAX_TARGET_PART_LENGTH = 2048

export type TargetResult = { ok: true; path: string; query: string } | { ok: false; reason: string }

const bad = (reason: string): TargetResult => ({ ok: false, reason })

/** A segment that is, or after one round of decoding turns into, a dot segment. */
function isDotSegment(segment: string): boolean {
  // `..;x` is a dot segment to servers that cut `;parameters` off a segment (Java servlet containers).
  const bare = segment.split(';')[0]!
  return bare === '.' || bare === '..'
}

function segmentProblem(raw: string): string | null {
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return 'invalid percent-encoding'
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return 'invalid UTF-8 in the path'
  }
  if (isDotSegment(raw) || isDotSegment(decoded)) return 'dot segment in the path'
  if (/[/\\\p{Cc}]/u.test(decoded)) return 'forbidden character in a path segment'
  // A second round of decoding must not find anything either (`%252e%252e`, `%252f`).
  if (/%(?:2e|2f|5c)/i.test(decoded)) return 'doubly encoded dot or separator in the path'
  return null
}

/**
 * `rest` is the request target after the account id, as received: `/dav/home/?a=b`.
 * The result `path` keeps its trailing slash; `query` is empty or starts with `?`.
 */
export function parseProxyTarget(rest: string): TargetResult {
  if (!rest.startsWith('/')) return bad('the path must start with /')
  // Two slashes at the start would read as a network-path reference somewhere down the line.
  if (rest.startsWith('//')) return bad('the path must not start with //')
  if (rest.includes('#')) return bad('fragment in the request target')

  const queryAt = rest.indexOf('?')
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt)
  const query = queryAt === -1 ? '' : rest.slice(queryAt)
  if (path.length > MAX_TARGET_PART_LENGTH) return bad('the path is too long')
  if (query.length > MAX_TARGET_PART_LENGTH) return bad('the query is too long')

  // Printable ASCII only: anything else must arrive percent-encoded, and a backslash is a
  // separator to the URL parser for http(s).
  if (/[^\x21-\x7e]/.test(path) || path.includes('\\'))
    return bad('forbidden character in the path')
  if (/[^\x21-\x7e]/.test(query) || query.includes('\\'))
    return bad('forbidden character in the query')
  if (/%(?![0-9A-Fa-f]{2})/.test(query)) return bad('invalid percent-encoding in the query')
  if (/%(?:[01][0-9a-fA-F]|7[fF])/.test(query)) return bad('control character in the query')

  const segments = path.slice(1).split('/')
  for (const [index, segment] of segments.entries()) {
    // Only the last segment may be empty (a collection's trailing slash).
    if (segment === '') {
      if (index !== segments.length - 1) return bad('empty path segment')
      continue
    }
    const problem = segmentProblem(segment)
    if (problem) return bad(problem)
  }
  return { ok: true, path, query }
}
