// What went wrong with a call to the app's API, in words for the person looking at the settings
// screen. `$fetch` throws a `FetchError`: `statusCode` is the HTTP status and `data` is the parsed
// body of the error response, which for our routes is h3's
//   { statusCode, statusMessage, message, data: { fields | code | reason } }
// (server/utils/api/errors.ts, server/utils/ical-proxy/nitro.ts). Without a response (offline) or
// without a session (`AuthRequiredError` as the `cause`) there is no body at all.
import { N_, t, tv } from '~/utils/i18n'

export type ApiErrorKind =
  'validation' | 'conflict' | 'not-found' | 'signed-out' | 'network' | 'server'

export interface ApiErrorInfo {
  kind: ApiErrorKind
  /** The HTTP status; null when there was no response. */
  status: number | null
  /** The server's own sentence (`message` of the body), when there is one. */
  message: string | null
  /** Rejected inputs of a 400, as the server reported them. */
  fields: { field: string; message: string }[]
  /** `duplicate` or `limit_reached` of a 409. */
  code: string | null
  /** Why the iCal proxy failed (502 of `/data`). */
  reason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function readFields(value: unknown): ApiErrorInfo['fields'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const field = text(item.field)
    const message = text(item.message)
    return field && message ? [{ field, message }] : []
  })
}

/**
 * The parsed body of the error response. A request made with `responseType: 'text'` (the iCal
 * check) leaves the body of an error as text too, so a JSON string is read here.
 */
function readBody(error: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(error.data)) return error.data
  if (typeof error.data !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(error.data)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readStatus(error: Record<string, unknown>): number | null {
  const body = readBody(error)
  const response = isRecord(error.response) ? error.response : {}
  for (const candidate of [error.statusCode, error.status, response.status, body.statusCode]) {
    if (typeof candidate === 'number' && candidate >= 100) return candidate
  }
  return null
}

function kindOf(status: number | null, cause: unknown): ApiErrorKind {
  // The auth wrapper refuses to send a request without a session (utils/auth/errors.ts).
  if (isRecord(cause) && cause.name === 'AuthRequiredError') return 'signed-out'
  if (status === null) return 'network'
  if (status === 401) return 'signed-out'
  if (status === 400) return 'validation'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  return 'server'
}

/** Sorts any thrown value into one of a few cases the screen knows how to word. */
export function parseApiError(error: unknown): ApiErrorInfo {
  const source = isRecord(error) ? error : {}
  const status = readStatus(source)
  const body = readBody(source)
  // Mocks and hand-made errors may put `fields`, `code` and `reason` at the top of the body.
  const details = isRecord(body.data) ? body.data : body
  return {
    kind: kindOf(status, source.cause),
    status,
    message: text(body.message),
    fields: readFields(details.fields),
    code: text(details.code),
    reason: text(details.reason),
  }
}

/** The part after "Could not ...:" for everything that is not about a specific input. */
export function describeFailure(info: ApiErrorInfo): string {
  switch (info.kind) {
    case 'signed-out':
      return t('You are signed out. Reload the page to sign in again.')
    case 'network':
      return t('The server could not be reached. Check your connection and try again.')
    case 'not-found':
      return t('It no longer exists. It may have been removed in another window.')
    case 'conflict':
    case 'validation':
      return info.message ?? t('The server did not accept the request.')
    case 'server':
      return info.status
        ? t('The server answered with an error (HTTP {status}).', { status: info.status })
        : t('The server answered with an error.')
  }
}

/** `Could not load your app tokens. The server could not be reached. ...` */
export function describeError(error: unknown, action: string): string {
  // `action` is a text marked with `N_` by the caller ("load your app tokens").
  return t('Could not {action}. {failure}', {
    action: tv(action),
    failure: describeFailure(parseApiError(error)),
  })
}

// ---- Inputs rejected by the server (400) -----------------------------------------------------

export interface FieldProblems {
  /** Message per known field, ready to show under the input. */
  byField: Record<string, string>
  /** Messages for fields this form does not have, for an alert. */
  other: string[]
}

/** The server words field problems as fragments that follow the field name ("must not be empty"). */
const KNOWN_FIELD_MESSAGES: Record<string, string> = {
  'must not point to a private or reserved network': N_(
    'This address points to a private or reserved network, which is not allowed.',
  ),
  'has a host name that cannot be resolved': N_(
    'The host name of this address cannot be found. Check it for typos.',
  ),
  'is more than you can see of this calendar; you see its busy times only': N_(
    'You see this calendar as busy times only, so a link to it can show busy times only.',
  ),
}

/**
 * Sorts the field errors of a 400 into the ones the form can show next to an input (`known`
 * maps a field to the name the sentence starts with) and the rest.
 */
export function fieldProblems(info: ApiErrorInfo, known: Record<string, string>): FieldProblems {
  const byField: Record<string, string> = {}
  const other: string[] = []
  for (const { field, message } of info.fields) {
    const name = known[field]
    const fixed = KNOWN_FIELD_MESSAGES[message]
    const sentence =
      (fixed ? tv(fixed) : null) ??
      (name ? t('{name} {message}.', { name: tv(name), message }) : null)
    if (name && sentence && !(field in byField)) byField[field] = sentence
    else other.push(`${field} ${message}`)
  }
  return { byField, other }
}

// ---- The app token endpoints -----------------------------------------------------------------

export const TOKEN_FIELDS = { label: N_('The label') }

export interface TokenFailure {
  /** Under the label input. */
  label?: string
  /** For an alert; empty when the label message covers it. */
  alert?: string
  /** True when the server says the limit is reached: reload the list and block the form. */
  limitReached: boolean
}

export function describeTokenCreateError(error: unknown): TokenFailure {
  const info = parseApiError(error)
  if (info.kind === 'conflict' && info.code === 'limit_reached') {
    return {
      alert: info.message ?? t('You have reached the limit of app tokens. Revoke one first.'),
      limitReached: true,
    }
  }
  if (info.kind === 'validation') {
    const { byField, other } = fieldProblems(info, TOKEN_FIELDS)
    const alert =
      other.length > 0
        ? t('The token was not created: {problems}.', { problems: other.join('; ') })
        : undefined
    return { label: byField.label, alert, limitReached: false }
  }
  return { alert: describeError(error, N_('create the token')), limitReached: false }
}

// ---- The iCal subscription endpoints ---------------------------------------------------------

export const SUBSCRIPTION_FIELDS = {
  name: N_('The name'),
  url: N_('The address'),
  color: N_('The colour'),
}

export interface SubscriptionFailure {
  byField: Record<string, string>
  alert?: string
}

/** For add (POST) and change (PUT). */
export function describeSubscriptionSaveError(error: unknown, action: string): SubscriptionFailure {
  const info = parseApiError(error)
  if (info.kind === 'conflict') {
    // A duplicate is about the address field; the limit is about the account.
    if (info.code === 'duplicate') {
      return { byField: { url: t('You already subscribed to this address.') } }
    }
    return { byField: {}, alert: info.message ?? t('You have reached the limit of subscriptions.') }
  }
  if (info.kind === 'validation') {
    const { byField, other } = fieldProblems(info, SUBSCRIPTION_FIELDS)
    const alert =
      other.length > 0
        ? t('Could not {action}: {problems}.', { action: tv(action), problems: other.join('; ') })
        : undefined
    return { byField, alert }
  }
  return { byField: {}, alert: describeError(error, action) }
}
