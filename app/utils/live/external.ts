// The external CalDAV accounts in the live loader (FR-8, NFR-4). Their calendars are found by
// asking each account's server (utils/external/discovery.ts), which can be slow or down, so this is
// a track of its own: the built-in calendars and the subscriptions never wait for it, and every
// account is merged into the sidebar as soon as it has answered. One failing account becomes one
// problem entry ("source:external:<id>") and keeps the calendars it had; it never touches another
// account or the built-in service.
//
// The loader owns the state and the reading of events; this module is given what it needs.
import type { Ref } from 'vue'
import type { Calendar } from '../../../shared/types/calendar'
import type { ExternalAccount } from '../../../shared/types/external'
import { DavError } from '../caldav/errors'
import { createLimiter } from '../caldav/flights'
import type { DavCalendar, DavRange } from '../caldav/types'
import type { ExternalSource } from '../external/source'
import type { ApiCalendarPref } from './api-types'
import {
  buildCalendars,
  externalAccountIdOf,
  isExternalRef,
  reconcileVisibleCalendars,
  type ExternalCollections,
} from './calendars'
import {
  describeLoadError,
  EXTERNAL_LIST_KEY,
  externalAccountIdOfKey,
  externalAccountKey,
  isAborted,
  isPasswordError,
} from './errors'
import type { CalendarOutcome } from './events'
import type { LiveStatusState } from './status'

/** Accounts listed at the same time; each takes one to four requests. */
const LISTING_CONCURRENCY = 4

export interface ExternalTrackDeps {
  source: ExternalSource
  store: { calendars: Ref<Calendar[]>; visibleCalendarIds: Ref<string[]> }
  status: LiveStatusState
  /** The viewer's calendar preferences as the last load of the sources read them. */
  prefs: () => readonly ApiCalendarPref[]
  /** Replaces the problems list (and tells about new ones). */
  setErrors: (next: Record<string, string>) => void
  /** Loads the events of some calendars now. */
  loadEvents: (options: { force: boolean; only: readonly string[] }) => Promise<void>
  /** Drops the events and messages of calendars and accounts that are gone. */
  prune: () => void
  beginWork: () => void
  endWork: () => void
  disposed: () => boolean
}

export interface ExternalTrack {
  /** Lists the accounts, then the calendars of each, then loads their events. */
  run: (force: boolean) => Promise<void>
  /** What the last listing found, for `buildCalendars`. */
  collections: () => ExternalCollections[]
  /** Whether a problem key names an account (or the list) that still exists. */
  knowsKey: (key: string) => boolean
  /** The events of calendars of one account. */
  read: (
    accountId: number,
    calendars: readonly Calendar[],
    range: DavRange,
    force: boolean,
  ) => Promise<CalendarOutcome[]>
}

function attempt<T>(run: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  return Promise.resolve()
    .then(run)
    .then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason: unknown) => ({ status: 'rejected', reason }) as const,
    )
}

interface Problem {
  message: string
  /** A new password may cure it; the account to ask about. */
  passwordFor: number | null
}

export function createExternalTrack(deps: ExternalTrackDeps): ExternalTrack {
  const { source, store, status } = deps
  const limiter = createLimiter(LISTING_CONCURRENCY)
  let accounts: ExternalAccount[] = []
  /** account id -> the calendars its server listed last. */
  const found = new Map<number, DavCalendar[]>()
  /** An older run's answers must not overwrite a newer run's. */
  let generation = 0

  function collections(): ExternalCollections[] {
    return accounts.flatMap((account) => {
      const list = found.get(account.id)
      return list ? [{ account, collections: list }] : []
    })
  }

  /** Sets (or, with null, removes) the problem entry `key`. */
  function report(key: string, problem: Problem | null) {
    const errors = new Map(Object.entries(status.errors.value))
    const fixes = new Map(Object.entries(status.passwordFor.value))
    if (problem === null) {
      if (!errors.delete(key)) return
      fixes.delete(key)
    } else {
      errors.set(key, problem.message)
      if (problem.passwordFor !== null) fixes.set(key, problem.passwordFor)
      else fixes.delete(key)
    }
    // Before the errors: `setErrors` drops fixes whose problem is gone.
    status.passwordFor.value = Object.fromEntries(fixes)
    deps.setErrors(Object.fromEntries(errors))
  }

  function failure(error: unknown, accountId: number | null): Problem {
    return {
      message: describeLoadError(error),
      passwordFor: accountId !== null && isPasswordError(error) ? accountId : null,
    }
  }

  /** Puts the calendars found so far into the sidebar. Returns the refs of all of them. */
  function mergeCalendars(): string[] {
    const previous = store.calendars.value
    const kept = previous.filter((calendar) => !isExternalRef(calendar.id))
    const external = buildCalendars({
      collections: [],
      subscriptions: [],
      prefs: deps.prefs(),
      external: collections(),
      paletteOffset: kept.length,
    })
    const next = [...kept, ...external]
    store.visibleCalendarIds.value = reconcileVisibleCalendars({
      visibleIds: store.visibleCalendarIds.value,
      previous,
      next,
    })
    store.calendars.value = next
    return external.map((calendar) => calendar.id)
  }

  async function loadAccount(account: ExternalAccount, force: boolean, current: () => boolean) {
    const key = externalAccountKey(account.id)
    // Only the asking is limited; the events of an account load while the others are still asked.
    const listed = await limiter.run(() => attempt(() => source.listCalendars(account)))
    if (!current()) return
    if (listed.status === 'rejected') {
      // A failed account keeps the calendars it had.
      if (!isAborted(listed.reason)) report(key, failure(listed.reason, account.id))
      return
    }
    found.set(account.id, listed.value)
    report(
      key,
      listed.value.length === 0
        ? { message: 'No calendars found at this address', passwordFor: null }
        : null,
    )
    const ids = mergeCalendars().filter((ref) => externalAccountIdOf(ref) === account.id)
    if (ids.length > 0) await deps.loadEvents({ force, only: ids })
  }

  async function run(force: boolean): Promise<void> {
    const ticket = ++generation
    const current = () => ticket === generation && !deps.disposed()
    deps.beginWork()
    try {
      const listed = await attempt(() => source.listAccounts())
      if (!current()) return
      if (listed.status === 'rejected') {
        // The accounts that were known stay as they were.
        if (!isAborted(listed.reason)) report(EXTERNAL_LIST_KEY, failure(listed.reason, null))
        return
      }
      report(EXTERNAL_LIST_KEY, null)
      accounts = listed.value.accounts
      status.externalAccounts.value = accounts

      const ids = new Set(accounts.map((account) => account.id))
      let removed = false
      for (const id of [...found.keys()]) {
        if (!ids.has(id)) {
          found.delete(id)
          removed = true
        }
      }
      if (removed) mergeCalendars()
      deps.prune()

      await Promise.all(accounts.map((account) => loadAccount(account, force, current)))
    } finally {
      deps.endWork()
    }
  }

  async function read(
    accountId: number,
    calendars: readonly Calendar[],
    range: DavRange,
    force: boolean,
  ): Promise<CalendarOutcome[]> {
    const failed = (error: unknown) =>
      calendars.map((calendar): CalendarOutcome => ({
        kind: 'failed',
        calendarId: calendar.id,
        error,
      }))
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account) return failed(new DavError('not-found', 'the account no longer exists'))
    try {
      // The server is not asked to expand series (see utils/external/source.ts): the reader does.
      const results = await source.read(
        account,
        calendars.map((calendar) => ({ url: calendar.href ?? '', expand: false })),
        range,
        { force },
      )
      return calendars.map((calendar, index): CalendarOutcome => {
        const result = results[index]
        if (result?.objects) {
          return {
            kind: 'caldav',
            calendarId: calendar.id,
            objects: result.objects,
            expandRecurrence: true,
          }
        }
        const error = result?.error ?? new DavError('bad-response', 'no result for the calendar')
        return { kind: 'failed', calendarId: calendar.id, error }
      })
    } catch (error) {
      return failed(error)
    }
  }

  return {
    run,
    collections,
    knowsKey(key) {
      if (key === EXTERNAL_LIST_KEY) return true
      const id = externalAccountIdOfKey(key)
      return id !== null && accounts.some((account) => account.id === id)
    },
    read,
  }
}
