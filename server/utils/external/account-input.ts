import {
  EXTERNAL_NAME_MAX_LENGTH,
  EXTERNAL_PASSWORD_MAX_LENGTH,
  EXTERNAL_URL_MAX_LENGTH,
  EXTERNAL_USERNAME_MAX_LENGTH,
  type ExternalAuthMode,
} from '../../../shared/types/external'
import type { ExternalAccountFields } from '../../db/external-accounts'
import { ApiError, type FieldError } from '../api/errors'
import {
  FieldErrors,
  finish,
  readChoice,
  readObject,
  readOptionalColor,
  readText,
  type Parsed,
} from '../api/validation'

// The body of POST / PUT /api/external-accounts, checked field by field so the form can show every
// problem at once. One function serves both: an update is merged over the stored account first
// (accounts.ts), so a change is validated exactly like a new account.

const MAX_HOSTNAME_LENGTH = 253
const AUTH_MODES: readonly ExternalAuthMode[] = ['none', 'basic']
/** Control characters and line or paragraph separators have no place in a name shown in a list. */
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u

export interface ExternalAccountInputOptions {
  /** A login over plain http. Tests and local development only (the SSRF switch). */
  allowInsecureLogins: boolean
}

export interface ParsedExternalAccount {
  fields: ExternalAccountFields
  /** To be sealed; null when the body carried none. Never stored. */
  password: string | null
}

function readUrl(
  value: unknown,
  authMode: ExternalAuthMode | undefined,
  options: ExternalAccountInputOptions,
  errors: FieldErrors,
): URL | undefined {
  if (value === undefined || value === null) {
    errors.add('url', 'is required')
    return undefined
  }
  if (typeof value !== 'string') {
    errors.add('url', 'must be a string')
    return undefined
  }
  const text = value.trim()
  if (text === '') {
    errors.add('url', 'must not be empty')
    return undefined
  }
  if (text.length > EXTERNAL_URL_MAX_LENGTH) {
    errors.add('url', `must have at most ${EXTERNAL_URL_MAX_LENGTH} characters`)
    return undefined
  }
  // `new URL('https://x/a#').hash` is empty, so the text is checked, not the parsed value.
  if (text.includes('#')) {
    errors.add('url', 'must not contain a fragment (#)')
    return undefined
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    errors.add('url', 'must be a valid address')
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    errors.add('url', 'must start with https:// (or http:// for an account without a login)')
    return undefined
  }
  if (url.username !== '' || url.password !== '') {
    errors.add('url', 'must not contain a user name or password')
    return undefined
  }
  if (url.hostname === '' || url.hostname.length > MAX_HOSTNAME_LENGTH) {
    errors.add('url', 'must have a valid host name')
    return undefined
  }
  if (url.protocol === 'http:' && authMode === 'basic' && !options.allowInsecureLogins) {
    errors.add('url', 'must start with https:// because the account has a login')
    return undefined
  }
  if (url.href.length > EXTERNAL_URL_MAX_LENGTH) {
    errors.add('url', `must have at most ${EXTERNAL_URL_MAX_LENGTH} characters`)
    return undefined
  }
  return url
}

function readPrintableName(value: unknown, errors: FieldErrors): string | undefined {
  const name = readText(value, 'name', EXTERNAL_NAME_MAX_LENGTH, errors)
  if (name !== undefined && UNPRINTABLE.test(name)) {
    errors.add('name', 'must not contain control characters')
    return undefined
  }
  return name
}

/** Exact, not trimmed: it is the user name the account's server knows. */
function readUsername(
  value: unknown,
  authMode: ExternalAuthMode | undefined,
  errors: FieldErrors,
): string | null | undefined {
  if (authMode !== 'basic') {
    if (value !== undefined && value !== null && value !== '' && authMode === 'none') {
      errors.add('username', 'must be empty for an account without a login')
    }
    return null
  }
  if (value === undefined || value === null || value === '') {
    errors.add('username', 'is required')
    return undefined
  }
  if (typeof value !== 'string') {
    errors.add('username', 'must be a string')
    return undefined
  }
  if (value.length > EXTERNAL_USERNAME_MAX_LENGTH) {
    errors.add('username', `must have at most ${EXTERNAL_USERNAME_MAX_LENGTH} characters`)
  } else if (value.trim() !== value || value.trim() === '') {
    errors.add('username', 'must not be blank or start or end with a blank')
  } else if (UNPRINTABLE.test(value)) {
    errors.add('username', 'must not contain control characters')
  } else if (value.includes(':')) {
    // HTTP Basic joins user name and password with ":" (RFC 7617).
    errors.add('username', 'must not contain a colon')
  } else {
    return value
  }
  return undefined
}

function readPassword(
  value: unknown,
  authMode: ExternalAuthMode | undefined,
  errors: FieldErrors,
): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    errors.add('password', 'must be a string')
    return null
  }
  if (value.length > EXTERNAL_PASSWORD_MAX_LENGTH) {
    errors.add('password', `must have at most ${EXTERNAL_PASSWORD_MAX_LENGTH} characters`)
    return null
  }
  if (authMode === 'none') {
    errors.add('password', 'must be empty for an account without a login')
    return null
  }
  return value
}

export function parseExternalAccountInput(
  body: unknown,
  options: ExternalAccountInputOptions,
): Parsed<ParsedExternalAccount> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const name = readPrintableName(source.name, errors)
  const authMode = readChoice(source.authMode, 'authMode', AUTH_MODES, errors)
  const color = readOptionalColor(source.color, 'color', errors)
  const url = readUrl(source.url, authMode, options, errors)
  const username = readUsername(source.username, authMode, errors)
  const password = readPassword(source.password, authMode, errors)

  return finish(errors, () => ({
    fields: {
      name: name!,
      url: url!.href,
      origin: url!.origin,
      authMode: authMode!,
      username: username ?? null,
      color: color ?? null,
    },
    password,
  }))
}

/**
 * The value, or the 400 to throw. A problem with the address carries `data.code: 'invalid_url'`
 * next to the fields.
 */
export function expectValidAccount<T>(parsed: Parsed<T>): T {
  if (parsed.ok) return parsed.value
  throw badAccountRequest(parsed.fields)
}

function badAccountRequest(fields: FieldError[]): ApiError {
  const url = fields.some((field) => field.field === 'url')
  return new ApiError(
    400,
    'The request is not valid',
    url ? { code: 'invalid_url', fields } : { fields },
  )
}
