// Shared shapes of the write path (FR-9): what the dialogs hand to the orchestration in
// orchestrate.ts and what comes back. Plain types, no Vue and no Nuxt.
import { N_ } from '../i18n'
import type { CalDavClient } from '../caldav/client'
import type { CalendarReader } from '../caldav/reader'

/**
 * Which events of a recurring series an edit or delete is about, as the dialog words it: "This
 * event", "This and following events" or "All events". A single event has no choice (`null`).
 */
export type ScopeChoice = 'this' | 'following' | 'all'

export const SCOPE_CHOICES: readonly ScopeChoice[] = ['this', 'following', 'all']

export const SCOPE_LABELS: Record<ScopeChoice, string> = {
  this: N_('This event'),
  following: N_('This and following events'),
  all: N_('All events'),
}

/** What the event is, as far as the write path needs: where it lives and which occurrence it is. */
export interface EventTarget {
  /** URL of the `.ics` resource (`CalendarEvent.href`). */
  href: string
  /** URL of the collection that holds it (`Calendar.href`); new resources are created there. */
  calendarHref: string
  /** `CalendarEvent.recurring`: part of a series. */
  recurring: boolean
  /** `CalendarEvent.recurrenceId`: the occurrence, for a recurring event. */
  recurrenceId?: string
}

/** The services a write needs; the Nuxt glue (useEventWrites) supplies the real ones. */
export interface WriteDeps {
  client: Pick<CalDavClient, 'getObject' | 'putObject' | 'deleteObject'>
  reader: Pick<CalendarReader, 'invalidate'>
  /** Reloads the visible events (`useLiveStatus().refresh`). */
  refresh: () => Promise<void>
  /** The zones of the person who writes (read when the write starts, not when the deps are made). */
  zones: () => { displayTimeZone: string; orgTimeZone: string }
  /** The clock for DTSTAMP and friends; tests pin it. */
  now?: () => Date
}

export type WriteFailureKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'exists'
  | 'unavailable'
  | 'network'
  | 'aborted'
  | 'bad-response'
  | 'rejected'
  | 'invalid-input'
  | 'unknown-instance'
  | 'unparseable'
  | 'unsupported'
  /** A series split wrote its new half but could not update the old one: events may be doubled. */
  | 'partial'
  | 'unknown'

export interface WriteFailure {
  kind: WriteFailureKind
  /** Plain words for the person, ready to show. */
  message: string
  /** The server's state may differ from what is shown: the orchestration already reloaded. */
  reload: boolean
  /** There is nothing to fix in the form: close it (the message goes into a toast). */
  closeForm: boolean
  /** The original error text, for the console; never shown. */
  detail?: string
}

export type WriteOutcome<T extends object = Record<never, never>> =
  ({ ok: true } & T) | { ok: false; failure: WriteFailure }
