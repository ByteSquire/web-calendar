// What went wrong with a call to `/api/external-accounts`, in words for the settings screen and the
// password dialog. The server names its reasons in `data.code` (`logins_disabled`,
// `credential_required`, `limit_reached`, `host_not_allowed`, `invalid_url`) next to the usual
// `fields` of a 400; `parseApiError` reads both. Nothing here repeats the request: ofetch's error
// holds the body, which may be a password.
import { N_, t, tv } from '~/utils/i18n'
import { MAX_EXTERNAL_ACCOUNTS } from '../../../shared/types/external'
import { describeError, fieldProblems, parseApiError } from '../settings/api-errors'

export const EXTERNAL_FIELDS = {
  name: N_('The name'),
  url: N_('The address'),
  username: N_('The user name'),
  password: N_('The password'),
  color: N_('The colour'),
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
        alert: t('You have reached the limit of {max} external accounts. Delete one first.', {
          max: MAX_EXTERNAL_ACCOUNTS,
        }),
      }
    case 'logins_disabled':
      return {
        byField: {},
        alert: t(
          'The administrator has not enabled logins for external accounts, so only accounts without a login can be added.',
        ),
      }
    case 'host_not_allowed':
      return {
        byField: {
          url: t(
            'The administrator has not allowed this server. Ask them to add its host name to the list of allowed hosts.',
          ),
        },
      }
    case 'invalid_url':
      return {
        byField: {
          url: t(
            'This address cannot be used. Check that it starts with https:// and names a public server.',
          ),
        },
      }
    case 'credential_required':
      return { byField: { password: t('Enter the password of the account.') } }
  }
  if (info.kind === 'validation') {
    const { byField, other } = fieldProblems(info, EXTERNAL_FIELDS)
    const alert =
      other.length > 0
        ? t('Could not {action}: {problems}.', { action: tv(action), problems: other.join('; ') })
        : undefined
    return { byField, alert }
  }
  if (info.kind === 'conflict') {
    return {
      byField: {},
      alert: t('Could not {action}. {failure}', {
        action: tv(action),
        failure: info.message ?? t('The account conflicts.'),
      }),
    }
  }
  return { byField: {}, alert: describeError(error, action) }
}
