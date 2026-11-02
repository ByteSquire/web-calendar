// Errors of the browser login and how to word them for the person looking at the screen.

import { t } from '../i18n'

/** There is no usable session: the user has to sign in again. */
export class AuthRequiredError extends Error {
  readonly reason: 'signed-out' | 'renewal-failed'

  constructor(reason: 'signed-out' | 'renewal-failed', options: { cause?: unknown } = {}) {
    super(
      reason === 'signed-out' ? 'Not signed in' : 'The session could not be renewed',
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'AuthRequiredError'
    this.reason = reason
  }
}

/** The server gave no usable sign-in settings (the issuer is empty). */
export class AuthConfigError extends Error {
  constructor() {
    super('Sign-in is not configured')
    this.name = 'AuthConfigError'
  }
}

export type AuthFailureKind = 'denied' | 'state' | 'network' | 'config' | 'other'

export interface AuthFailure {
  kind: AuthFailureKind
  title: string
  message: string
  /** The technical text, for people who report the problem. */
  detail: string | null
}

// oidc-client-ts marks its error classes with `name`, which survives bundling and duck typing.
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

const STATE_MESSAGES = /no matching state|no state in response|state does not match/i
// What browsers and the library say when the provider cannot be reached.
const NETWORK_MESSAGES = /network error|failed to fetch|load failed|networkerror|timed? ?out/i

/**
 * Sorts a failure of the login into a few cases and words it for the callback page. The provider's
 * own error text is only given as `detail`, never as the message.
 */
export function describeAuthError(error: unknown): AuthFailure {
  const text = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && 'error' in error
      ? String((error as { error: unknown }).error ?? '')
      : ''
  const detail = code ? `${code}${text && text !== code ? `: ${text}` : ''}` : text || null

  if (error instanceof AuthConfigError) {
    return {
      kind: 'config',
      title: t('Sign-in is not set up'),
      message: t('This server has no sign-in provider configured. Ask an administrator.'),
      detail,
    }
  }
  if (errorName(error) === 'ErrorResponse' && code !== '') {
    if (code === 'access_denied' || code === 'login_required' || code === 'consent_required') {
      return {
        kind: 'denied',
        title: t('Sign-in was cancelled'),
        message: t(
          'The sign-in was cancelled or you do not have access to this app. You can try again.',
        ),
        detail,
      }
    }
    return {
      kind: 'other',
      title: t('Sign-in failed'),
      message: t('The sign-in server did not accept the request. Try again.'),
      detail,
    }
  }
  if (STATE_MESSAGES.test(text)) {
    return {
      kind: 'state',
      title: t('This sign-in has expired'),
      message: t(
        'The sign-in could not be matched to this browser tab. This happens when the page was reloaded, opened twice or left waiting for too long. Try again.',
      ),
      detail,
    }
  }
  if (errorName(error) === 'ErrorTimeout' || NETWORK_MESSAGES.test(text)) {
    return {
      kind: 'network',
      title: t('Cannot reach the sign-in server'),
      message: t('Check your connection and try again.'),
      detail,
    }
  }
  return {
    kind: 'other',
    title: t('Sign-in failed'),
    message: t(
      'Something went wrong while signing in. Try again; if it keeps happening, ask an administrator.',
    ),
    detail,
  }
}
