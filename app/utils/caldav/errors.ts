// Errors of the CalDAV transport. Callers branch on `kind` (what the UI should do), never on
// status codes or message text, so every HTTP status and every thrown fetch error lands in one of
// a few kinds here.

export type DavErrorKind =
  /** 401: the token is missing, expired or refused. */
  | 'unauthorized'
  /** 403: the user may not do this (read-only calendar, someone else's data). */
  | 'forbidden'
  /** 404 / 410. */
  | 'not-found'
  /** 412 on a conditional write or delete: the resource changed meanwhile. Also a plain 409. */
  | 'conflict'
  /** A create (`If-None-Match: *` or MKCALENDAR) hit something that is already there. */
  | 'exists'
  /** 5xx, 408 and 429: the service is down or busy; retrying later may help. */
  | 'unavailable'
  /** The request never got an answer (offline, DNS, TLS, CORS, timeout). */
  | 'network'
  /** The caller's `AbortSignal` fired. */
  | 'aborted'
  /** The server answered, but not with what CalDAV promises (malformed XML, an HTML page). */
  | 'bad-response'
  /** Any other 4xx (400 bad iCalendar, 405, 413, 415): the server refused this very request. */
  | 'rejected'

export class DavError extends Error {
  readonly kind: DavErrorKind
  /** The HTTP status, when the server answered. */
  readonly status?: number

  constructor(kind: DavErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DavError'
    this.kind = kind
    if (options?.status !== undefined) this.status = options.status
  }
}

export function kindForStatus(status: number): DavErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404 || status === 410) return 'not-found'
  if (status === 409 || status === 412) return 'conflict'
  if (status >= 500 || status === 408 || status === 429) return 'unavailable'
  return status >= 400 ? 'rejected' : 'bad-response'
}

/**
 * The error for a failed HTTP answer. `kind` overrides the default mapping where the request gives
 * the status another meaning (a 412 on a create is "exists", not "changed meanwhile").
 */
export function errorForStatus(method: string, status: number, kind?: DavErrorKind): DavError {
  return new DavError(kind ?? kindForStatus(status), `${method} failed with HTTP ${status}`, {
    status,
  })
}

/** Name checks instead of `instanceof`: the abort error may come from another realm or a polyfill. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  )
}

/**
 * Anything thrown while talking to the server, as a `DavError`. A `DavError` passes through, so the
 * injected `fetch` (token renewal) can fail with `unauthorized` itself. An abort that comes from
 * `AbortSignal.timeout()` is a timeout, which the UI treats like a dead network, not like the user
 * having moved on.
 */
export function errorFromThrown(error: unknown, signal?: AbortSignal): DavError {
  if (error instanceof DavError) return error
  if (isTimeout(error) || (signal?.aborted && isTimeout(signal.reason))) {
    return new DavError('network', 'the request timed out', { cause: error })
  }
  if (signal?.aborted || isAbortError(error)) {
    return new DavError('aborted', 'the request was aborted', { cause: error })
  }
  return new DavError('network', 'the request failed before an answer arrived', { cause: error })
}
