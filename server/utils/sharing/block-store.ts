import { createRadicaleClient, type RadicaleClient } from './radicale-client'
import { AVAILABILITY_PATH, RESOURCES_PRINCIPAL, type SharingResult } from './types'

// Where the resource availability blocks live: `/_resources/availability/<blockRef>.ics`, written
// as the service principal `_resources`. Users never get write there; the reconcile shares the
// collection with `f` to web_calendar_users (desired.ts availabilityShare).

export interface ResourceBlockStore {
  put(path: string, ics: string): Promise<void>
  delete(path: string): Promise<void>
}

const BLOCK_PATH = /^\/_resources\/availability\/[A-Za-z0-9_-]{1,128}\.ics$/

/** Creates the home and the availability collection when missing. */
export async function ensureAvailabilityCollection(
  client: RadicaleClient,
): Promise<SharingResult<void>> {
  const home = await client.propfind(RESOURCES_PRINCIPAL, `/${RESOURCES_PRINCIPAL}/`, 0)
  // A 404 or an empty answer is fine: the first request creates the home.
  if (!home.ok && home.failure.kind !== 'rejected') return home
  return client.makeCalendar(RESOURCES_PRINCIPAL, AVAILABILITY_PATH, 'Availability')
}

/**
 * The writer for resource blocks. `put` and `delete` throw when Radicale refuses or cannot be
 * reached, so a booking can mark itself orphaned and retry. Without a client the one for the
 * configured Radicale is used.
 */
export function createResourceBlockStore(
  options: { client?: RadicaleClient } = {},
): ResourceBlockStore {
  const client =
    options.client ?? createRadicaleClient({ baseUrl: useRuntimeConfig().radicale.url })
  let ensured = false

  function checked(path: string): void {
    if (!BLOCK_PATH.test(path)) throw new Error('not a resource block path')
  }

  async function ensure(): Promise<void> {
    if (ensured) return
    const result = await ensureAvailabilityCollection(client)
    if (!result.ok) throw new Error(`resource block store: ${result.failure.message}`)
    ensured = true
  }

  return {
    async put(path, ics) {
      checked(path)
      await ensure()
      const result = await client.putObject(RESOURCES_PRINCIPAL, path, ics)
      if (!result.ok) {
        // The collection may have been deleted behind our back; ask again next time.
        ensured = false
        throw new Error(`resource block store: ${result.failure.message}`)
      }
    },
    async delete(path) {
      checked(path)
      const result = await client.deleteObject(RESOURCES_PRINCIPAL, path)
      if (!result.ok) throw new Error(`resource block store: ${result.failure.message}`)
    },
  }
}
