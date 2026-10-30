// Plain words for everything that can go wrong when an event is written (FR-9, NFR-4). The
// transport and the iCalendar writer fail with kinds and codes; the UI shows these sentences and
// branches on `reload` / `closeForm`, never on message text.
import { DavError } from '../caldav/errors'
import { EditError } from '../ical/write-types'
import type { ScopeChoice, WriteFailure } from './types'

export type WriteAction = 'create' | 'edit' | 'delete'

export interface DescribeOptions {
  /** The scope the person chose, for the message about a series that cannot be moved as a whole. */
  scope?: ScopeChoice | null
  /** The new half of a split series was already written when this error happened. */
  partial?: boolean
}

export const CHANGED_BY_SOMEONE_ELSE =
  'This event was changed by someone else. It has been reloaded — try again.'

const SERIES_NOT_CHANGEABLE =
  "All events of this series can't be changed this way. Edit single occurrences, or choose " +
  '"This and following events".'

function failure(
  kind: WriteFailure['kind'],
  message: string,
  flags: { reload?: boolean; closeForm?: boolean } = {},
  error?: unknown,
): WriteFailure {
  const detail =
    error instanceof Error ? error.message : error === undefined ? undefined : String(error)
  return {
    kind,
    message,
    reload: flags.reload ?? false,
    closeForm: flags.closeForm ?? false,
    ...(detail === undefined ? {} : { detail }),
  }
}

function describeDavError(error: DavError, action: WriteAction): WriteFailure {
  switch (error.kind) {
    case 'unauthorized':
      return failure('unauthorized', 'Your sign-in expired. Sign in again.', {}, error)
    case 'forbidden':
      return failure('forbidden', "You can't write to this calendar.", {}, error)
    case 'not-found':
      return action === 'create'
        ? failure(
            'not-found',
            'This calendar no longer exists. Reload the page and choose another calendar.',
            { reload: true },
            error,
          )
        : failure(
            'not-found',
            action === 'delete'
              ? 'This event was already deleted. The calendar has been reloaded.'
              : 'This event no longer exists. The calendar has been reloaded.',
            { reload: true, closeForm: true },
            error,
          )
    case 'conflict':
      return action === 'create'
        ? failure(
            'conflict',
            'The calendar service could not save the event because of a conflict. Try again.',
            {},
            error,
          )
        : failure('conflict', CHANGED_BY_SOMEONE_ELSE, { reload: true, closeForm: true }, error)
    case 'exists':
      return failure('exists', 'An event with this id already exists. Try again.', {}, error)
    case 'unavailable':
      return failure(
        'unavailable',
        'The calendar service is busy or down. Try again in a moment.',
        {},
        error,
      )
    case 'network':
      return failure(
        'network',
        'The calendar service is not reachable. Check your connection and try again.',
        {},
        error,
      )
    case 'aborted':
      return failure('aborted', 'The request was cancelled. Try again.', {}, error)
    case 'bad-response':
      // The write may have gone through: show what the server has.
      return failure(
        'bad-response',
        'The calendar service gave an unexpected answer. The calendar has been reloaded; check whether the change was saved.',
        { reload: true, closeForm: true },
        error,
      )
    case 'rejected':
      return failure(
        'rejected',
        'The calendar service did not accept this change. Check the details and try again.',
        {},
        error,
      )
  }
}

function describeEditError(error: EditError, options: DescribeOptions): WriteFailure {
  switch (error.code) {
    case 'invalid-input':
      return failure('invalid-input', error.message, {}, error)
    case 'unknown-instance':
      return failure(
        'unknown-instance',
        'This occurrence no longer exists. The calendar has been reloaded.',
        { reload: true, closeForm: true },
        error,
      )
    case 'unparseable':
      return failure(
        'unparseable',
        "This event is stored in a form this app can't read, so it can't be changed here.",
        { closeForm: true },
        error,
      )
    case 'unsupported':
      return failure(
        'unsupported',
        // The writer's words say why (a rule that does not follow a move to another day, a time
        // zone nobody can resolve); for the whole series they come with the way out.
        options.scope === 'all' ? SERIES_NOT_CHANGEABLE : error.message,
        {},
        error,
      )
  }
}

/** The part of a series split that is already saved when the old half could not be updated. */
function describePartial(cause: WriteFailure): WriteFailure {
  const reason =
    cause.kind === 'conflict'
      ? ' because someone else changed it'
      : cause.kind === 'network' || cause.kind === 'unavailable'
        ? ' because the calendar service could not be reached'
        : ''
  return {
    ...cause,
    kind: 'partial',
    message:
      `Part of this change was saved: the following events were copied into a new series, but the original ` +
      `could not be updated${reason}. Some events may now appear twice. The calendar has been reloaded; delete the extra events.`,
    reload: true,
    closeForm: true,
  }
}

/** Any error thrown by a write, as words and flags the UI can act on. */
export function describeWriteError(
  error: unknown,
  action: WriteAction,
  options: DescribeOptions = {},
): WriteFailure {
  let result: WriteFailure
  if (error instanceof DavError) result = describeDavError(error, action)
  else if (error instanceof EditError) result = describeEditError(error, options)
  else {
    result = failure(
      'unknown',
      action === 'delete'
        ? 'Something went wrong while deleting the event. Try again.'
        : 'Something went wrong while saving the event. Try again.',
      {},
      error,
    )
  }
  return options.partial ? describePartial(result) : result
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof DavError && error.kind === 'not-found'
}

export const SUCCESS_TITLES = {
  created: 'Event added',
  updated: 'Event updated',
  unchanged: 'Nothing to save',
  deleted: 'Event deleted',
  alreadyDeleted: 'Event was already deleted',
} as const
