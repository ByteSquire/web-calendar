// Creating, editing and deleting events on the calendar service (FR-9). Pure orchestration with
// injected services: fetch the resource, let the iCalendar writer (app/utils/ical/write.ts) produce
// the new text, write it back with the ETag of the copy that was just read, then drop the reader's
// cache and reload. Nothing here knows about Vue; useEventWrites() supplies the real client.
//
// Failures never throw: every function returns `{ ok: false, failure }` with words for the person
// (messages.ts) and flags that say whether the calendar was reloaded and the form should close.
import { DavError } from '../caldav/errors'
import { ensureTrailingSlash } from '../caldav/urls'
import {
  createEventResource,
  deleteFromEventResource,
  editEventResource,
  EditError,
  type EditScope,
  type EventChanges,
  type NewEventInput,
  type WriteContext,
} from '../ical/write'
import { describeWriteError, isNotFoundError, type WriteAction } from './messages'
import type { EventTarget, ScopeChoice, WriteDeps, WriteFailure, WriteOutcome } from './types'

/** The resource URL of a new event: named after its UID, which is a UUID and safe in a path. */
export function resourceUrl(calendarHref: string, uid: string): string {
  return `${ensureTrailingSlash(calendarHref)}${encodeURIComponent(uid)}.ics`
}

/**
 * The writer's scope for what the person chose. A single event has no choice. A recurring event
 * needs the occurrence id for "this event" and "this and following"; "all events" may name it so
 * a time change made on a later occurrence moves the whole series by the same amount.
 */
export function editScopeFor(target: EventTarget, choice: ScopeChoice | null): EditScope {
  if (!target.recurring) return { kind: 'series' }
  const { recurrenceId } = target
  if (choice === 'all') return { kind: 'series', ...(recurrenceId ? { recurrenceId } : {}) }
  if (!recurrenceId) {
    throw new EditError('unknown-instance', 'The event does not say which occurrence it is.')
  }
  return choice === 'following'
    ? { kind: 'thisAndFollowing', recurrenceId }
    : { kind: 'instance', recurrenceId }
}

function writeContext(deps: WriteDeps): WriteContext {
  return { ...deps.zones(), ...(deps.now ? { now: deps.now() } : {}) }
}

/** Forget the cached answer for the calendar and load again; a failed reload is the loader's to show. */
async function reload(deps: WriteDeps, calendarHref: string): Promise<void> {
  deps.reader.invalidate(calendarHref)
  try {
    await deps.refresh()
  } catch {
    // The write itself worked; the loader reports its own failure.
  }
}

async function failed(
  deps: WriteDeps,
  error: unknown,
  action: WriteAction,
  calendarHref: string,
  options: { scope?: ScopeChoice | null; partial?: boolean } = {},
): Promise<{ ok: false; failure: WriteFailure }> {
  const failure = describeWriteError(error, action, options)
  if (failure.reload) await reload(deps, calendarHref)
  return { ok: false, failure }
}

// ---------------------------------------------------------------------------------------------
// Create

/**
 * Creates the event in the calendar. A UID that is already taken in the collection (practically
 * never, they are UUIDs) is retried once with a fresh one, which needs a fresh resource.
 */
export async function createEvent(
  deps: WriteDeps,
  args: { calendarHref: string; input: NewEventInput },
): Promise<WriteOutcome<{ uid: string; url: string }>> {
  let saved: { uid: string; url: string }
  try {
    let attempt = 0
    for (;;) {
      const resource = createEventResource(args.input, writeContext(deps))
      const url = resourceUrl(args.calendarHref, resource.uid)
      try {
        await deps.client.putObject({ url, data: resource.ics, create: true })
        saved = { uid: resource.uid, url }
        break
      } catch (error) {
        attempt += 1
        if (!(error instanceof DavError && error.kind === 'exists' && attempt < 2)) throw error
      }
    }
  } catch (error) {
    return failed(deps, error, 'create', args.calendarHref)
  }
  await reload(deps, args.calendarHref)
  return { ok: true, ...saved }
}

// ---------------------------------------------------------------------------------------------
// Edit

export interface EditArgs {
  target: EventTarget
  /** The answer to "which events?"; null for a single event. */
  scope: ScopeChoice | null
  /** Only the fields the person changed. */
  changes: EventChanges
}

/**
 * Edits the event. The resource is fetched again and the PUT carries the ETag of THAT copy, never
 * the one in the calendar state, which may be older. "This and following" can produce a second
 * resource: it is written first, so a failure afterwards leaves a duplicate instead of losing the
 * later events.
 */
export async function editEvent(
  deps: WriteDeps,
  args: EditArgs,
): Promise<WriteOutcome<{ unchanged: boolean; split: boolean }>> {
  const { target, changes } = args
  if (Object.keys(changes).length === 0) return { ok: true, unchanged: true, split: false }

  let wroteNewHalf = false
  try {
    const scope = editScopeFor(target, args.scope)
    const object = await deps.client.getObject(target.href)
    const result = editEventResource(object.data, scope, changes, writeContext(deps))
    if (result.updated === object.data && result.created === null) {
      return { ok: true, unchanged: true, split: false }
    }
    if (result.created) {
      await deps.client.putObject({
        url: resourceUrl(target.calendarHref, result.created.uid),
        data: result.created.ics,
        create: true,
      })
      wroteNewHalf = true
    }
    if (result.updated === null) await deps.client.deleteObject(target.href, object.etag)
    else await deps.client.putObject({ url: target.href, data: result.updated, etag: object.etag })
  } catch (error) {
    return failed(deps, error, 'edit', target.calendarHref, {
      scope: args.scope,
      partial: wroteNewHalf,
    })
  }
  await reload(deps, target.calendarHref)
  return { ok: true, unchanged: false, split: wroteNewHalf }
}

// ---------------------------------------------------------------------------------------------
// Delete

export interface DeleteArgs {
  target: EventTarget
  scope: ScopeChoice | null
}

/**
 * Deletes the event, or the chosen part of a series. When nothing is left of the resource it is
 * deleted (with the fetched ETag), otherwise the shortened resource is written back. An event that
 * is already gone counts as deleted.
 */
export async function deleteEvent(
  deps: WriteDeps,
  args: DeleteArgs,
): Promise<WriteOutcome<{ alreadyGone: boolean }>> {
  const { target } = args
  try {
    const scope = editScopeFor(target, args.scope)
    const object = await deps.client.getObject(target.href)
    const result = deleteFromEventResource(object.data, scope, writeContext(deps))
    if (result.updated === null) await deps.client.deleteObject(target.href, object.etag)
    else await deps.client.putObject({ url: target.href, data: result.updated, etag: object.etag })
  } catch (error) {
    if (isNotFoundError(error)) {
      await reload(deps, target.calendarHref)
      return { ok: true, alreadyGone: true }
    }
    return failed(deps, error, 'delete', target.calendarHref, { scope: args.scope })
  }
  await reload(deps, target.calendarHref)
  return { ok: true, alreadyGone: false }
}
