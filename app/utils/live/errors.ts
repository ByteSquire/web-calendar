// How a failed load is worded for the sidebar: short, no technical detail, no URLs (a subscription
// URL may hold a secret). Callers branch on the error's kind or reason, never on message text.
import { DavError, type DavErrorKind } from '../caldav/errors'

/** Keys of `errors` that are not calendars: the other sources the loader reads. */
export const SOURCE_KEYS = {
  me: 'source:me',
  prefs: 'source:prefs',
  categories: 'source:categories',
  filters: 'source:filters',
  views: 'source:views',
  subscriptions: 'source:subscriptions',
  calendars: 'source:calendars',
} as const

export type SourceKey = (typeof SOURCE_KEYS)[keyof typeof SOURCE_KEYS]

export const SOURCE_LABELS: Record<SourceKey, string> = {
  'source:me': 'Your profile',
  'source:prefs': 'Calendar settings',
  'source:categories': 'Categories',
  'source:filters': 'Filters',
  'source:views': 'Views',
  'source:subscriptions': 'iCal subscriptions',
  'source:calendars': 'Calendar list',
}

export function isSourceKey(key: string): key is SourceKey {
  return key in SOURCE_LABELS
}

const DAV_MESSAGES: Record<DavErrorKind, string> = {
  unauthorized: 'Sign-in expired',
  forbidden: 'Access denied',
  'not-found': 'Not found',
  conflict: 'Changed on the server',
  exists: 'Already exists',
  unavailable: 'Server unavailable',
  network: 'Not reachable',
  aborted: 'Cancelled',
  'bad-response': 'Unexpected answer from the server',
  rejected: 'Request refused by the server',
}

/** Why the iCal proxy could not fetch a subscription (`data.reason` of its 502 answer). */
const ICAL_REASONS: Record<string, string> = {
  blocked: 'Address not allowed',
  unreachable: 'Not reachable',
  timeout: 'Source took too long',
  'too-large': 'File too large',
  'not-ical': 'Not a calendar file',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nameOf(error: unknown): string {
  return isRecord(error) && typeof error.name === 'string' ? error.name : ''
}

/** The login could not provide a token: the renewal failed or the user signed out elsewhere. */
export function isAuthRequired(error: unknown): boolean {
  return nameOf(error) === 'AuthRequiredError'
}

/** True when the load was cancelled on purpose; that is not a problem to show. */
export function isAborted(error: unknown): boolean {
  return error instanceof DavError ? error.kind === 'aborted' : nameOf(error) === 'AbortError'
}

function httpStatusOf(error: unknown): number | null {
  if (!isRecord(error)) return null
  for (const key of ['status', 'statusCode']) {
    const value = error[key]
    if (typeof value === 'number') return value
  }
  return null
}

function reasonOf(error: unknown): string | null {
  if (!isRecord(error)) return null
  if (typeof error.reason === 'string') return error.reason
  const data = error.data
  if (isRecord(data) && typeof data.reason === 'string') return data.reason
  if (isRecord(data) && isRecord(data.data) && typeof data.data.reason === 'string') {
    return data.data.reason
  }
  return null
}

/** Short wording for whatever failed while loading one source. */
export function describeLoadError(error: unknown): string {
  if (error instanceof DavError) return DAV_MESSAGES[error.kind]
  if (isAuthRequired(error)) return DAV_MESSAGES.unauthorized
  // ofetch wraps what `fetch` throws; the login's error is then the cause.
  if (isRecord(error) && isAuthRequired(error.cause)) return DAV_MESSAGES.unauthorized

  const reason = reasonOf(error)
  if (reason !== null) {
    const known = ICAL_REASONS[reason]
    if (known) return known
    const http = /^http-(\d{3})$/.exec(reason)
    if (http) return `The source answered with HTTP ${http[1]}`
  }
  const status = httpStatusOf(error)
  if (status === 401) return DAV_MESSAGES.unauthorized
  if (status === 403) return DAV_MESSAGES.forbidden
  if (status === 404) return DAV_MESSAGES['not-found']
  if (status !== null && status >= 500) return DAV_MESSAGES.unavailable
  if (status !== null) return DAV_MESSAGES.rejected
  // A `TypeError: Failed to fetch` and its relatives: the request got no answer.
  if (error instanceof TypeError) return DAV_MESSAGES.network
  return 'Could not be loaded'
}
