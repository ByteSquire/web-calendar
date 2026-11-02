// How a failed load is worded for the sidebar: short, no technical detail, no URLs (a subscription
// URL may hold a secret). Callers branch on the error's kind or reason, never on message text.
import { N_, t, tv } from '../i18n'
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
  resources: 'source:resources',
  availability: 'source:availability',
} as const

export type SourceKey = (typeof SOURCE_KEYS)[keyof typeof SOURCE_KEYS]

export const SOURCE_LABELS: Record<SourceKey, string> = {
  'source:me': N_('Your profile'),
  'source:prefs': N_('Calendar settings'),
  'source:categories': N_('Categories'),
  'source:filters': N_('Filters'),
  'source:views': N_('Views'),
  'source:subscriptions': N_('iCal subscriptions'),
  'source:calendars': N_('Calendar list'),
  'source:resources': N_('Resources'),
  'source:availability': N_('Resource availability'),
}

/** The list of external accounts itself could not be read. */
export const EXTERNAL_LIST_KEY = 'source:external'

/** One external account as a whole: its calendars could not be listed, or its login failed. */
export function externalAccountKey(accountId: number): string {
  return `${EXTERNAL_LIST_KEY}:${accountId}`
}

/** The account id of an `externalAccountKey`, or null for any other string. */
export function externalAccountIdOfKey(key: string): number | null {
  const match = /^source:external:([1-9][0-9]{0,14})$/.exec(key)
  return match ? Number(match[1]) : null
}

/** Source keys of the external accounts. They are replaced by their own track of the loader. */
export function isExternalSourceKey(key: string): boolean {
  return key === EXTERNAL_LIST_KEY || externalAccountIdOfKey(key) !== null
}

export function isSourceKey(key: string): boolean {
  return key in SOURCE_LABELS || isExternalSourceKey(key)
}

/** The name of a source in the problems list; `accountName` knows the external accounts. */
export function sourceLabel(key: string, accountName: (id: number) => string | undefined): string {
  if (key in SOURCE_LABELS) return tv(SOURCE_LABELS[key as SourceKey])
  const accountId = externalAccountIdOfKey(key)
  if (accountId !== null) return accountName(accountId) ?? t('External account')
  return key === EXTERNAL_LIST_KEY ? t('External accounts') : t('Calendar')
}

const DAV_MESSAGES: Record<DavErrorKind, string> = {
  unauthorized: N_('Sign-in expired'),
  forbidden: N_('Access denied'),
  'not-found': N_('Not found'),
  conflict: N_('Changed on the server'),
  exists: N_('Already exists'),
  unavailable: N_('Server unavailable'),
  network: N_('Not reachable'),
  aborted: N_('Request cancelled'),
  'bad-response': N_('Unexpected answer from the server'),
  rejected: N_('Request refused by the server'),
  'login-rejected': N_('Login rejected'),
  'credential-needed': N_('Password needed'),
  'host-not-allowed': N_('Server not allowed'),
  'rate-limited': N_('Too many requests'),
}

/** Why the iCal proxy could not fetch a subscription (`data.reason` of its 502 answer). */
const ICAL_REASONS: Record<string, string> = {
  blocked: N_('Address not allowed'),
  unreachable: N_('Not reachable'),
  timeout: N_('Source took too long'),
  'too-large': N_('File too large'),
  'not-ical': N_('Not a calendar file'),
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

/** A new password for the external account may cure this (none entered yet, or refused). */
export function isPasswordError(error: unknown): boolean {
  return (
    error instanceof DavError &&
    (error.kind === 'credential-needed' || error.kind === 'login-rejected')
  )
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
  if (error instanceof DavError) return tv(DAV_MESSAGES[error.kind])
  if (isAuthRequired(error)) return tv(DAV_MESSAGES.unauthorized)
  // ofetch wraps what `fetch` throws; the login's error is then the cause.
  if (isRecord(error) && isAuthRequired(error.cause)) return tv(DAV_MESSAGES.unauthorized)

  const reason = reasonOf(error)
  if (reason !== null) {
    const known = ICAL_REASONS[reason]
    if (known) return tv(known)
    const http = /^http-(\d{3})$/.exec(reason)
    if (http) return t('The source answered with HTTP {code}', { code: http[1] ?? '' })
  }
  const status = httpStatusOf(error)
  if (status === 401) return tv(DAV_MESSAGES.unauthorized)
  if (status === 403) return tv(DAV_MESSAGES.forbidden)
  if (status === 404) return tv(DAV_MESSAGES['not-found'])
  if (status !== null && status >= 500) return tv(DAV_MESSAGES.unavailable)
  if (status !== null) return tv(DAV_MESSAGES.rejected)
  // A `TypeError: Failed to fetch` and its relatives: the request got no answer.
  if (error instanceof TypeError) return tv(DAV_MESSAGES.network)
  return t('Could not be loaded')
}
