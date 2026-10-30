// The "Check connection" button of an external account (FR-8): ask the account's server for its
// calendars through the proxy and say in words whether it works, or why not. The same discovery
// the calendar view runs, so a green check means the calendars will load.
import { DavError } from '../caldav/errors'
import { pluralize } from '../settings/format'

/** `Works: 3 calendars found.` */
export function describeCheckOk(calendars: number): string {
  return calendars === 0
    ? 'The server answered, but no calendar was found at this address.'
    : `Works: ${pluralize(calendars, 'calendar')} found.`
}

/** One sentence for a failed check, from whatever discovery threw. */
export function describeCheckFailure(error: unknown): string {
  if (!(error instanceof DavError)) return 'The connection failed.'
  switch (error.kind) {
    case 'login-rejected':
      return 'The server rejected the login. Check the user name and enter the password again.'
    case 'credential-needed':
      return 'This browser has no password for the account. Enter it first.'
    case 'host-not-allowed':
      return 'The administrator has not allowed this server.'
    case 'rate-limited':
      return 'Too many requests. Try again in a moment.'
    case 'network':
      return 'The server could not be reached.'
    case 'unauthorized':
      return 'You are signed out. Reload the page to sign in again.'
    case 'not-found':
      return 'Nothing was found at this address.'
    case 'forbidden':
      return 'The server denied access.'
    case 'unavailable':
      return 'The server is not available right now.'
    case 'bad-response':
      return 'The address did not answer like a CalDAV server.'
    default:
      return 'The server refused the request.'
  }
}

/**
 * What to add to "saved" when the person asked to remember the password on this device and the
 * browser refused (private window, blocked or full storage): the credential then lives in memory
 * only.
 */
export function rememberNote(requested: boolean, kept: boolean): string {
  return requested && !kept
    ? ' This browser did not allow keeping it on this device, so it is kept until you close this tab.'
    : ''
}
