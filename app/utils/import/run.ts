// Writing the events of an imported file to a calendar (FR-7, FR-9): one `PUT` per event with
// `If-None-Match: *`, a few at a time, with a result for every event. Nothing is overwritten: an
// event the calendar already has (the same name, or the same UID under another name) is reported as
// "already there", so importing a file twice is safe and a failed run can simply be run again.
// Failures never throw. One event the service refuses (too large, not accepted) costs only itself;
// an answer that holds for all of them (signed out, no right to write, the calendar is gone) or
// several outages in a row stop the run, since every request after it would fail the same way.
//
// Pure orchestration with an injected client, like writes/orchestrate.ts; the settings section binds
// it to the session's client, reloads the calendar afterwards and drives the progress and cancel.
import { createLimiter } from '../caldav/flights'
import { DavError } from '../caldav/errors'
import type { CalDavClient } from '../caldav/client'
import { resourceKey } from '../caldav/urls'
import type { SplitResource } from '../ical/split'
import { CONCURRENCY, MAX_CONSECUTIVE_FAILURES } from './limits'
import { describeFailure, NOT_TRIED_CANCELLED, NOT_TRIED_STOPPED } from './messages'
import { resourceHref, resourceName } from './naming'
import { titleOf } from './preview'

export type ItemStatus =
  /** Written. */
  | 'created'
  /** The calendar has this event already; left alone. */
  | 'exists'
  /** The calendar service did not take it; `message` says why. */
  | 'failed'
  /** Never sent; `message` says why (cancelled, or the run stopped). */
  | 'not-done'
  /** Being sent when the person cancelled: the service may have saved it. */
  | 'interrupted'

export interface ImportItem {
  uid: string
  /** The title as it is shown. */
  title: string
  status: ItemStatus
  /** Plain words for everything but `created`. */
  message?: string
}

export interface ImportReport {
  /** One per event of the file, in the file's order. */
  items: ImportItem[]
  created: number
  exists: number
  failed: number
  notDone: number
  interrupted: number
  /** The person cancelled. */
  cancelled: boolean
  /** Why the run stopped before its end, in words; null when it did not (or was cancelled). */
  stopped: string | null
}

export interface ImportProgress {
  /** Events dealt with so far. */
  done: number
  total: number
}

export type ImportClient = Pick<CalDavClient, 'putObject' | 'listCalendars'>

export interface ImportArgs {
  /** The collection to write to, as `Calendar.href`. */
  calendarHref: string
  resources: readonly SplitResource[]
  /** Aborting stops new requests and cancels the running ones. */
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

/**
 * Why the calendar cannot be written to, or null when it can. The answer to a `PUT` into a missing
 * collection (409) looks like the one for a UID that is taken, so this is asked first: otherwise a
 * deleted calendar would report every event as "already there".
 */
async function calendarProblem(
  client: ImportClient,
  calendarHref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const calendars = await client.listCalendars(signal)
  const found = calendars.find(
    (calendar) => resourceKey(calendar.url) === resourceKey(calendarHref),
  )
  if (!found) return 'This calendar no longer exists. Reload the page and choose another calendar.'
  if (found.readOnly) return "You can't write to this calendar."
  return null
}

export async function runImport(client: ImportClient, args: ImportArgs): Promise<ImportReport> {
  const { resources, signal } = args
  const total = resources.length
  const items: ImportItem[] = resources.map((resource) => ({
    uid: resource.uid,
    title: titleOf(resource.summary),
    status: 'not-done',
  }))
  let stopped: string | null = null
  let done = 0
  let streak = 0

  try {
    stopped = await calendarProblem(client, args.calendarHref, signal)
  } catch (error) {
    if (!(error instanceof DavError && error.kind === 'aborted')) {
      stopped = describeFailure(error).message
    }
  }

  const limiter = createLimiter(CONCURRENCY)
  await Promise.all(
    resources.map((resource, index) =>
      limiter.run(async () => {
        if (stopped !== null || signal?.aborted) return
        const item = items[index]!
        try {
          const url = resourceHref(args.calendarHref, await resourceName(resource.uid))
          await client.putObject({
            url,
            data: resource.ics,
            create: true,
            ...(signal ? { signal } : {}),
          })
          item.status = 'created'
          streak = 0
        } catch (error) {
          const failure = describeFailure(error)
          item.status = failure.status
          item.message = failure.message
          if (failure.stops) stopped ??= failure.message
          // An event the service refuses is its own problem; an outage will hit the next one too.
          streak = failure.systemic ? streak + 1 : 0
          if (streak >= MAX_CONSECUTIVE_FAILURES) {
            stopped ??= `Stopped after ${streak} failures in a row. ${failure.message}`
          }
        }
        if (item.status === 'not-done' || item.status === 'interrupted') return
        done += 1
        args.onProgress?.({ done, total })
      }),
    ),
  )

  const cancelled = signal?.aborted === true
  for (const item of items) {
    if (item.status !== 'not-done') continue
    item.message = cancelled ? NOT_TRIED_CANCELLED : NOT_TRIED_STOPPED
  }
  const count = (status: ItemStatus) => items.filter((item) => item.status === status).length
  return {
    items,
    created: count('created'),
    exists: count('exists'),
    failed: count('failed'),
    notDone: count('not-done'),
    interrupted: count('interrupted'),
    cancelled,
    stopped: cancelled ? null : stopped,
  }
}
