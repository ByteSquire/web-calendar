// What went wrong with a call to `/api/external-accounts`, in words for the settings screen and the
// password dialog. The server names its reasons in `data.code` (`logins_disabled`,
// `credential_required`, `limit_reached`, `host_not_allowed`, `invalid_url`) next to the usual
// `fields` of a 400; `parseApiError` reads both. Nothing here repeats the request: ofetch's error
// holds the body, which may be a password.
import { MAX_EXTERNAL_ACCOUNTS } from '../../../shared/types/external'
import { describeError, fieldProblems, parseApiError } from '../settings/api-errors'

export const EXTERNAL_FIELDS = {
  name: 'The name',
  url: 'The address',
  username: 'The user name',
  password: 'The password',
  color: 'The colour',
}

export interface ExternalFailure {
  /** Under the input it is about. */
  byField: Record<string, string>
  /** For an alert. */
  alert?: string
}

/** For add (POST), change (PUT) and the password route. `action` completes "Could not ...". */
export function describeExternalSaveError(error: unknown, action: string): ExternalFailure {
  const info = parseApiError(error)
  switch (info.code) {
    case 'limit_reached':
      return {
        byField: {},
        alert: `You have reached the limit of ${MAX_EXTERNAL_ACCOUNTS} external accounts. Delete one first.`,
      }
    case 'logins_disabled':
      return {
        byField: {},
        alert:
          'The administrator has not enabled logins for external accounts, so only accounts without a login can be added.',
      }
    case 'host_not_allowed':
      return {
        byField: {
          url: 'The administrator has not allowed this server. Ask them to add its host name to the list of allowed hosts.',
        },
      }
    case 'invalid_url':
      return {
        byField: {
          url: 'This address cannot be used. Check that it starts with https:// and names a public server.',
        },
      }
    case 'credential_required':
      return { byField: { password: 'Enter the password of the account.' } }
  }
  if (info.kind === 'validation') {
    const { byField, other } = fieldProblems(info, EXTERNAL_FIELDS)
    const alert = other.length > 0 ? `Could not ${action}: ${other.join('; ')}.` : undefined
    return { byField, alert }
  }
  if (info.kind === 'conflict') {
    return {
      byField: {},
      alert: `Could not ${action}. ${info.message ?? 'The account conflicts.'}`,
    }
  }
  return { byField: {}, alert: describeError(error, action) }
}
