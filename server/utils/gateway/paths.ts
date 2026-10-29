/** Public prefix of the gateway; Radicale is told about it with `X-Script-Name`. */
export const GATEWAY_PREFIX = '/caldav'

export type PathRejectionKind =
  /** Not a path we can read safely: traversal, bad encoding, empty segments, control characters. */
  | 'malformed'
  /** A well-formed path that is not under `/caldav/`. */
  | 'outside-prefix'
  /** A dot-name at the root of the store (`.sharing`, `.web`): Radicale's own namespace. */
  | 'reserved'

export class PathRejection extends Error {
  readonly kind: PathRejectionKind

  constructor(kind: PathRejectionKind, message: string) {
    super(message)
    this.name = 'PathRejection'
    this.kind = kind
  }
}

export interface ResolvedPath {
  /** What Radicale receives: the public path without `/caldav`, canonically percent-encoded. */
  upstreamPath: string
  /** The same resource in public form, `/caldav/...`. */
  publicPath: string
}

const malformed = (message: string) => new PathRejection('malformed', message)

function hasForbiddenCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x2f /* / */ || code === 0x5c /* \ */) return true
  }
  return false
}

function decodeSegment(raw: string): string {
  // Anything outside printable ASCII must arrive percent-encoded.
  if (/[^\x21-\x7e]/.test(raw)) throw malformed('unencoded character in path')
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) throw malformed('invalid percent-encoding')
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw malformed('invalid UTF-8 in path')
  }
  if (decoded === '.' || decoded === '..') throw malformed('dot segment in path')
  if (hasForbiddenCharacter(decoded)) throw malformed('forbidden character in path segment')
  return decoded
}

/**
 * Turns the raw request target of a request to `/caldav/...` into the path sent to Radicale.
 *
 * The target is read as the client wrote it, because `URL` would silently resolve `..` and `%2e%2e`.
 * Every segment is decoded once and must not turn into a dot segment, a separator, a control
 * character or invalid UTF-8; empty segments (`//`) are refused. The result is re-encoded, so what
 * Radicale decodes is exactly what was checked. The query string is dropped (Radicale's WebDAV
 * methods do not use one); with `allowQuery: false` its presence is an error.
 */
export function resolvePublicPath(
  target: string,
  options: { allowQuery?: boolean } = {},
): ResolvedPath {
  // Origin-form only: no absolute URLs, no `//host`, no `*`.
  if (!target.startsWith('/') || target.startsWith('//')) throw malformed('not an absolute path')
  if (target.includes('#')) throw malformed('fragment in request target')
  const queryAt = target.indexOf('?')
  if (queryAt !== -1 && options.allowQuery === false) throw malformed('query not allowed')
  const rawPath = queryAt === -1 ? target : target.slice(0, queryAt)

  const [prefix, ...rest] = rawPath.slice(1).split('/')
  if (prefix !== GATEWAY_PREFIX.slice(1)) {
    throw new PathRejection('outside-prefix', 'path is not under /caldav/')
  }
  // `/caldav` and `/caldav/` are the store's root; the only empty segment allowed is the last one.
  if (rest.length === 1 && rest[0] === '') rest.pop()
  const segments = rest.map((raw, index) => {
    if (raw === '' && index !== rest.length - 1) throw malformed('empty path segment')
    return raw === '' ? raw : decodeSegment(raw)
  })
  if (segments[0]?.startsWith('.')) throw new PathRejection('reserved', 'reserved path')

  const upstreamPath = '/' + segments.map(encodeURIComponent).join('/')
  return {
    upstreamPath,
    publicPath: upstreamPath === '/' ? `${GATEWAY_PREFIX}/` : GATEWAY_PREFIX + upstreamPath,
  }
}

/**
 * The `Destination` header of COPY and MOVE as Radicale needs it: a path under `/caldav/`, normalised
 * like a request path. A URL is reduced to its path; the host is not used, since the gateway never
 * contacts it. A destination outside `/caldav/` is `outside-prefix`.
 */
export function rewriteDestination(value: string): string {
  const absolute = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(value)
  let target = value
  if (absolute) {
    const [, scheme, authority, path] = absolute
    if (!/^https?$/i.test(scheme!)) throw malformed('unsupported destination scheme')
    if (/[@\\\s]/.test(authority!)) throw malformed('invalid destination authority')
    target = path!
  }
  return resolvePublicPath(target, { allowQuery: false }).publicPath
}
