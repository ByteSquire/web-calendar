// Turning a category into a status, or deleting it from the events (no status), in every calendar
// the person can change: first the events are found (the server filters by the category, then the
// exact name is checked here), and shown as a count before anything is written; then each resource
// is rewritten with `categoryToStatus` and put back with its ETag. A resource that changed meanwhile
// is read again and tried once more; one that still fails is counted and named, and the others go
// on. Calendars the person can only read are not searched: their events are not theirs to change.
import type { Calendar } from '../../../shared/types/calendar'
import type { CalDavClient } from '../caldav/client'
import { DavError } from '../caldav/errors'
import type { DavObject } from '../caldav/types'
import { categoryToStatus, hasCategory } from '../ical/category-status'
import type { EventStatusValue, WriteContext } from '../ical/write-types'
import { isWritableCalendar } from './rules'

export type CategoryStatusClient = Pick<
  CalDavClient,
  'findObjectsWithCategory' | 'getObject' | 'putObject'
>

export interface FoundInCalendar {
  calendar: Calendar
  objects: DavObject[]
}

export interface CategorySearch {
  found: FoundInCalendar[]
  /** Calendars that could not be searched, with why. */
  failed: { calendar: Calendar; error: unknown }[]
}

/** The resources with an event of the category, in each calendar the person can change. */
export async function findCategoryEvents(
  client: CategoryStatusClient,
  calendars: readonly Calendar[],
  name: string,
  ctx: WriteContext,
  signal?: AbortSignal,
): Promise<CategorySearch> {
  const found: FoundInCalendar[] = []
  const failed: CategorySearch['failed'] = []
  for (const calendar of calendars.filter(isWritableCalendar)) {
    try {
      const objects = (
        await client.findObjectsWithCategory(calendar.href!, name, { signal })
      ).filter((object) => {
        try {
          return hasCategory(object.data, name, ctx)
        } catch {
          // Not an event this app can read: left as it is.
          return false
        }
      })
      if (objects.length > 0) found.push({ calendar, objects })
    } catch (error) {
      if (signal?.aborted) throw error
      failed.push({ calendar, error })
    }
  }
  return { found, failed }
}

export interface CategoryStatusResult {
  changed: number
  /** Resources that needed no change (they had the status already and keep the category). */
  unchanged: number
  failed: { calendar: Calendar; url: string; error: unknown }[]
}

/** Rewrites every resource found, one after the other; `onProgress` hears after each. */
export async function convertCategoryEvents(
  client: CategoryStatusClient,
  found: readonly FoundInCalendar[],
  name: string,
  status: EventStatusValue | null,
  options: { removeCategory: boolean },
  ctx: WriteContext,
  onProgress?: (done: number, total: number) => void,
): Promise<CategoryStatusResult> {
  const total = found.reduce((sum, entry) => sum + entry.objects.length, 0)
  const result: CategoryStatusResult = { changed: 0, unchanged: 0, failed: [] }
  let done = 0
  for (const { calendar, objects } of found) {
    for (const object of objects) {
      try {
        const outcome = await convertOne(client, object, name, status, options, ctx)
        if (outcome === 'changed') result.changed += 1
        else result.unchanged += 1
      } catch (error) {
        result.failed.push({ calendar, url: object.url, error })
      }
      done += 1
      onProgress?.(done, total)
    }
  }
  return result
}

async function convertOne(
  client: CategoryStatusClient,
  object: DavObject,
  name: string,
  status: EventStatusValue | null,
  options: { removeCategory: boolean },
  ctx: WriteContext,
): Promise<'changed' | 'unchanged'> {
  let current = object
  for (let attempt = 0; ; attempt++) {
    const next = categoryToStatus(current.data, name, status, options, ctx)
    if (next === null) return 'unchanged'
    try {
      await client.putObject({ url: current.url, data: next, etag: current.etag })
      return 'changed'
    } catch (error) {
      // Changed by somebody else since it was read: read it again and try once more.
      if (attempt === 0 && error instanceof DavError && error.kind === 'conflict') {
        current = await client.getObject(current.url)
        continue
      }
      throw error
    }
  }
}
