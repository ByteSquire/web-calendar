// Plain words for what happens to the events of an import (FR-7, NFR-4). The CalDAV transport fails
// with kinds, the UI shows these sentences and acts on the flags, never on message text. They are
// worded for a list of events ("Too large for the calendar service."), unlike writes/messages.ts,
// which answers a single dialog.
import { DavError } from '../caldav/errors'
import { pluralize } from '../settings/format'
import type { ImportReport, ItemStatus } from './run'

export const ALREADY_THERE = 'Already in the calendar.'
export const NOT_TRIED_CANCELLED = 'Not imported: the import was cancelled.'
export const INTERRUPTED = 'Cancelled while it was being sent. It may have been saved.'
export const NOT_TRIED_STOPPED = 'Not imported: the import stopped before it got here.'

export interface ItemFailure {
  status: Exclude<ItemStatus, 'created'>
  message: string
  /** What holds for every event (signed out, no right to write, no calendar): stop the run. */
  stops: boolean
  /** The service seems down or unreachable. Several in a row stop the run; the next may still work. */
  systemic: boolean
}

const failed = (
  message: string,
  flags: { stops?: boolean; systemic?: boolean } = {},
): ItemFailure => ({
  status: 'failed',
  message,
  stops: flags.stops ?? false,
  systemic: flags.systemic ?? false,
})

/** What an error from writing one event means for that event and for the rest of the run. */
export function describeFailure(error: unknown): ItemFailure {
  if (!(error instanceof DavError)) {
    // Not a transport error: a bug or a missing browser feature, the same for the next event.
    return failed('Something went wrong while saving this event.', { systemic: true })
  }
  switch (error.kind) {
    case 'exists':
      return { status: 'exists', message: ALREADY_THERE, stops: false, systemic: false }
    case 'conflict':
      // 409: the collection holds an event with this UID under another name (RFC 4791
      // `no-uid-conflict`). A missing collection answers 409 too; runImport has checked it exists.
      return error.status === 409
        ? { status: 'exists', message: ALREADY_THERE, stops: false, systemic: false }
        : failed('The calendar service could not save this event because of a conflict.')
    case 'aborted':
      return { status: 'interrupted', message: INTERRUPTED, stops: false, systemic: false }
    case 'unauthorized':
      return failed('Your sign-in expired. Sign in again.', { stops: true })
    case 'forbidden':
      return failed("You can't write to this calendar.", { stops: true })
    case 'not-found':
      return failed(
        'This calendar no longer exists. Reload the page and choose another calendar.',
        {
          stops: true,
        },
      )
    case 'rejected':
      return failed(
        error.status === 413
          ? 'Too large for the calendar service.'
          : 'The calendar service did not accept this event.',
      )
    case 'unavailable':
      return failed('The calendar service is busy or down.', { systemic: true })
    case 'network':
      return failed('The calendar service is not reachable.', { systemic: true })
    case 'bad-response':
      return failed(
        'The calendar service gave an unexpected answer. The event may have been saved: import again to check.',
        { systemic: true },
      )
    // Only external accounts raise these, and an import writes to the built-in service.
    case 'login-rejected':
    case 'credential-needed':
    case 'host-not-allowed':
    case 'rate-limited':
      return failed('Something went wrong while saving this event.', { systemic: true })
  }
}

const were = (count: number) => (count === 1 ? 'was' : 'were')

/** The outcome of a run in a few sentences, for the status line. */
export function summarize(report: ImportReport): string {
  const parts = [
    report.created > 0
      ? `Imported ${pluralize(report.created, 'event')}.`
      : 'Nothing was imported.',
  ]
  if (report.exists > 0) {
    parts.push(
      `${pluralize(report.exists, 'event')} ${were(report.exists)} already in the calendar.`,
    )
  }
  if (report.failed > 0) {
    parts.push(`${pluralize(report.failed, 'event')} could not be imported.`)
  }
  if (report.notDone > 0) {
    parts.push(
      `${pluralize(report.notDone, 'event')} ${were(report.notDone)} not imported because the import ` +
        `${report.cancelled ? 'was cancelled' : 'stopped'}.`,
    )
  }
  if (report.interrupted > 0) {
    parts.push(
      `${pluralize(report.interrupted, 'event')} ${were(report.interrupted)} being sent when the import ` +
        'was cancelled and may have been saved.',
    )
  }
  return parts.join(' ')
}
