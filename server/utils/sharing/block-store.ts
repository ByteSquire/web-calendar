import { resourceCalendarId } from '../../../shared/utils/resource-calendar-name'
import { RESOURCES_HOME, resourceCollection } from '../resources/block'
import { parseHomeListing } from './calendars'
import { createRadicaleClient, type RadicaleClient } from './radicale-client'
import { LEGACY_AVAILABILITY_PATH, RESOURCES_PRINCIPAL, type SharingResult } from './types'

// Where the resource availability blocks live: one calendar per resource,
// `/_resources/resource-<id>/<blockRef>.ics`, written as the service principal `_resources` and
// named after the resource. Users never get write there; the reconcile shares each calendar read
// to everyone who may see its resource (desired.ts `resourceShares`) and keeps the collections in
// line with the resources (`syncResourceCollections`).

export interface ResourceBlockStore {
  put(path: string, ics: string): Promise<void>
  delete(path: string): Promise<void>
}

const BLOCK_PATH = /^\/_resources\/(resource-[1-9][0-9]{0,14})\/[0-9a-f]{32}\.ics$/

const ok: SharingResult<void> = { ok: true, value: undefined }

export interface ResourceCollectionsResult {
  /** Resources whose calendar could not be made or renamed; their shares wait. */
  failed: number[]
  /** What went wrong, one line each, naming no person. */
  problems: string[]
}

/**
 * Makes the `_resources` home hold exactly one calendar per resource, named after it: creates the
 * missing ones, renames the ones whose resource was renamed, and deletes the calendars of deleted
 * resources and the one collection of all blocks used before (LEGACY_AVAILABILITY_PATH). Fails as
 * a whole only when Radicale cannot be reached.
 */
export async function syncResourceCollections(
  client: RadicaleClient,
  resources: readonly { id: number; name: string }[],
): Promise<SharingResult<ResourceCollectionsResult>> {
  const listing = await client.propfind(RESOURCES_PRINCIPAL, RESOURCES_HOME, 1)
  // A 404 or an empty answer is fine: the first request creates the home.
  if (!listing.ok && listing.failure.kind === 'unreachable') return listing
  const present = new Map<string, string>()
  if (listing.ok) {
    for (const calendar of parseHomeListing(listing.value, RESOURCES_PRINCIPAL)) {
      present.set(calendar.path, calendar.displayName)
    }
  }
  const result: ResourceCollectionsResult = { failed: [], problems: [] }
  const wanted = new Set<string>()
  for (const resource of resources) {
    const path = resourceCollection(resource.id)
    wanted.add(path)
    const shown = present.get(path)
    const change =
      shown === undefined
        ? await client.makeCalendar(RESOURCES_PRINCIPAL, path, resource.name)
        : shown === resource.name
          ? ok
          : await client.updateCalendar(RESOURCES_PRINCIPAL, path, { displayName: resource.name })
    if (!change.ok) {
      if (change.failure.kind === 'unreachable') return change
      result.failed.push(resource.id)
      result.problems.push(`calendar of resource ${resource.id}: ${change.failure.message}`)
    }
  }
  for (const path of present.keys()) {
    const name = path.slice(RESOURCES_HOME.length, -1)
    const stale = path === LEGACY_AVAILABILITY_PATH || resourceCalendarId(name) !== null
    if (!stale || wanted.has(path)) continue
    const removed = await client.deleteCollection(RESOURCES_PRINCIPAL, path)
    if (!removed.ok) {
      if (removed.failure.kind === 'unreachable') return removed
      result.problems.push(`old resource collection ${name}: ${removed.failure.message}`)
    }
  }
  return { ok: true, value: result }
}

/**
 * The writer for resource blocks. `put` and `delete` throw when Radicale refuses or cannot be
 * reached, so a booking can mark itself orphaned and retry. A resource's calendar is made on the
 * first block, named by `nameOf` (the reconcile renames it later). A block whose text this process
 * wrote already is not written again, so the repair can look at every booking; a restart writes
 * each once. Without a client the one for the configured Radicale is used.
 */
export function createResourceBlockStore(options: {
  client?: RadicaleClient
  /** The name of a resource for its calendar; null when it is gone. */
  nameOf: (resourceId: number) => string | null
}): ResourceBlockStore {
  const client =
    options.client ?? createRadicaleClient({ baseUrl: useRuntimeConfig().radicale.url })
  const ensured = new Set<string>()
  const written = new Map<string, string>()

  function collectionOf(path: string): { collection: string; resourceId: number } {
    const match = BLOCK_PATH.exec(path)
    const resourceId = match ? resourceCalendarId(match[1]!) : null
    if (!match || resourceId === null) throw new Error('not a resource block path')
    return { collection: `${RESOURCES_HOME}${match[1]}/`, resourceId }
  }

  async function ensure(collection: string, resourceId: number): Promise<void> {
    if (ensured.has(collection)) return
    const name = options.nameOf(resourceId)
    if (name === null) throw new Error('resource block store: the resource is gone')
    const made = await client.makeCalendar(RESOURCES_PRINCIPAL, collection, name)
    if (!made.ok) throw new Error(`resource block store: ${made.failure.message}`)
    ensured.add(collection)
  }

  return {
    async put(path, ics) {
      const { collection, resourceId } = collectionOf(path)
      if (written.get(path) === ics) return
      await ensure(collection, resourceId)
      const result = await client.putObject(RESOURCES_PRINCIPAL, path, ics)
      if (!result.ok) {
        // The collection may have been deleted behind our back; ask again next time.
        ensured.delete(collection)
        written.delete(path)
        throw new Error(`resource block store: ${result.failure.message}`)
      }
      written.set(path, ics)
    },
    async delete(path) {
      collectionOf(path)
      written.delete(path)
      const result = await client.deleteObject(RESOURCES_PRINCIPAL, path)
      if (!result.ok) throw new Error(`resource block store: ${result.failure.message}`)
    },
  }
}
