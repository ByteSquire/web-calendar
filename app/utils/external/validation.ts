// Checks of the external account form in the browser (FR-8). They only spare a round trip: the
// server checks again and its answer wins (utils/external/api-errors.ts shows what it rejected).
// The limits come from shared/types/external.ts; the messages are complete sentences for the field
// they appear under.
import {
  EXTERNAL_NAME_MAX_LENGTH,
  EXTERNAL_PASSWORD_MAX_LENGTH,
  EXTERNAL_URL_MAX_LENGTH,
  EXTERNAL_USERNAME_MAX_LENGTH,
  type ExternalAccount,
  type ExternalAuthMode,
} from '../../../shared/types/external'
import { t } from '~/utils/i18n'
import { hasControlChars } from '../caldav/urls'

const MAX_HOSTNAME_LENGTH = 253

export function validateExternalName(value: string): string | undefined {
  const name = value.trim()
  if (name === '') return t('Enter a name for the account.')
  if (name.length > EXTERNAL_NAME_MAX_LENGTH) {
    return t('The name can have at most {max} characters.', { max: EXTERNAL_NAME_MAX_LENGTH })
  }
  return undefined
}

/**
 * The address of a calendar home, a principal or one calendar. An account with a login needs
 * https: otherwise the password would cross the network unencrypted.
 */
export function validateExternalUrl(value: string, authMode: ExternalAuthMode): string | undefined {
  const text = value.trim()
  if (text === '') return t('Enter the address of the CalDAV server.')
  if (text.length > EXTERNAL_URL_MAX_LENGTH) {
    return t('The address can have at most {max} characters.', { max: EXTERNAL_URL_MAX_LENGTH })
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return t('Enter a valid address, for example https://dav.example.org/calendars/me/.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return t('The address must start with http:// or https://.')
  }
  if (url.username !== '' || url.password !== '') {
    return t('The address must not contain a user name or password. Enter them below.')
  }
  if (url.hostname === '' || url.hostname.length > MAX_HOSTNAME_LENGTH) {
    return t('The address needs a valid host name.')
  }
  if (authMode === 'basic' && url.protocol !== 'https:') {
    return t(
      'An account with a login needs an https:// address, so that the password is encrypted.',
    )
  }
  return undefined
}

export function validateExternalUsername(value: string): string | undefined {
  if (value.trim() === '') return t('Enter the user name of the account.')
  if (value.length > EXTERNAL_USERNAME_MAX_LENGTH) {
    return t('The user name can have at most {max} characters.', {
      max: EXTERNAL_USERNAME_MAX_LENGTH,
    })
  }
  // RFC 7617: the user name of Basic authentication cannot hold a colon.
  if (value.includes(':')) return t('The user name must not contain a colon.')
  if (hasControlChars(value)) return t('The user name must not contain control characters.')
  return undefined
}

/** `required`: the form has no sealed credential to keep (see `passwordRequired`). */
export function validateExternalPassword(value: string, required: boolean): string | undefined {
  if (value === '') return required ? t('Enter the password of the account.') : undefined
  if (value.length > EXTERNAL_PASSWORD_MAX_LENGTH) {
    return t('The password can have at most {max} characters.', {
      max: EXTERNAL_PASSWORD_MAX_LENGTH,
    })
  }
  if (hasControlChars(value)) return t('The password must not contain control characters.')
  return undefined
}

export interface ExternalFormValues {
  name: string
  url: string
  authMode: ExternalAuthMode
  username: string
  password: string
}

export type ExternalFormErrors = Partial<
  Record<'name' | 'url' | 'username' | 'password' | 'authMode', string>
>

export interface ExternalFormContext {
  /** False when the server cannot seal passwords: only accounts without a login are possible. */
  loginsEnabled: boolean
  /** See `passwordRequired`. */
  passwordRequired: boolean
}

export function validateExternalForm(
  values: ExternalFormValues,
  context: ExternalFormContext,
): ExternalFormErrors {
  const errors: ExternalFormErrors = {}
  const name = validateExternalName(values.name)
  const url = validateExternalUrl(values.url, values.authMode)
  if (name) errors.name = name
  if (url) errors.url = url
  if (values.authMode === 'basic') {
    if (!context.loginsEnabled) {
      errors.authMode = t('The administrator has not enabled logins for external accounts.')
    }
    const username = validateExternalUsername(values.username)
    const password = validateExternalPassword(values.password, context.passwordRequired)
    if (username) errors.username = username
    if (password) errors.password = password
  }
  return errors
}

/** The origin of an address, or null when it is none. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * Whether the form must be given a password. A new account with a login needs one. For a change,
 * the sealed credential is bound to the origin and the user name, so a change of either, or a
 * switch to a login, voids it; otherwise leaving the field empty keeps the old one.
 */
export function passwordRequired(
  values: Pick<ExternalFormValues, 'url' | 'authMode' | 'username'>,
  original?: Pick<ExternalAccount, 'url' | 'authMode' | 'username'>,
): boolean {
  if (values.authMode !== 'basic') return false
  if (!original || original.authMode !== 'basic') return true
  return (
    originOf(values.url) !== originOf(original.url) ||
    values.username.trim() !== (original.username ?? '')
  )
}
