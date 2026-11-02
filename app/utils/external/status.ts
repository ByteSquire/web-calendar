// The "Check connection" button of an external account (FR-8): ask the account's server for its
// calendars through the proxy and say in words whether it works, or why not. The same discovery
// the calendar view runs, so a green check means the calendars will load.
import { tc, t } from '~/utils/i18n'
import { DavError } from '../caldav/errors'

/** `Works: 3 calendars found.` */
export function describeCheckOk(calendars: number): string {
  return calendars === 0
    ? t('The server answered, but no calendar was found at this address.')
    : tc('Works: {count} calendar found. | Works: {count} calendars found.', calendars)
}

/** One sentence for a failed check, from whatever discovery threw. */
export function describeCheckFailure(error: unknown): string {
  if (!(error instanceof DavError)) return t('The connection failed.')
  switch (error.kind) {
    case 'login-rejected':
      return t('The server rejected the login. Check the user name and enter the password again.')
    case 'credential-needed':
      return t('This browser has no password for the account. Enter it first.')
    case 'host-not-allowed':
      return t('The administrator has not allowed this server.')
    case 'rate-limited':
      return t('Too many requests. Try again in a moment.')
    case 'network':
      return t('The server could not be reached.')
    case 'unauthorized':
      return t('You are signed out. Reload the page to sign in again.')
    case 'not-found':
      return t('Nothing was found at this address.')
    case 'forbidden':
      return t('The server denied access.')
    case 'unavailable':
      return t('The server is not available right now.')
    case 'bad-response':
      return t('The address did not answer like a CalDAV server.')
    default:
      return t('The server refused the request.')
  }
}

/**
 * What to add to "saved" when the person asked to remember the password on this device and the
 * browser refused (private window, blocked or full storage): the credential then lives in memory
 * only.
 */
export function rememberNote(requested: boolean, kept: boolean): string {
  return requested && !kept
    ? t(
        ' This browser did not allow keeping it on this device, so it is kept until you close this tab.',
      )
    : ''
}
