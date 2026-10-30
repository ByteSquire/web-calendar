// The `fetch` the CalDAV client uses: the authenticated one, with its login failure worded the way
// the client understands. The client passes a `DavError` thrown by its `fetch` through and turns
// any other throw into `network`; a failed token renewal is not a network problem, it means the
// user has to sign in again.
import { DavError } from '../caldav/errors'
import { isAuthRequired } from './errors'

export function davFetchFrom(authFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await authFetch(input, init)
    } catch (error) {
      if (isAuthRequired(error)) {
        throw new DavError('unauthorized', 'the sign-in is no longer valid', { cause: error })
      }
      throw error
    }
  }
}
