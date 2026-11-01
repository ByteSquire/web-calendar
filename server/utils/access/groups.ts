// Whether a Kanidm group exists, asked with the group-sync token (read-only).
import { createKanidmClient, type KanidmClientOptions } from '../group-sync/kanidm'

export type GroupAnswer = 'exists' | 'missing' | 'unavailable'
export type GroupLookup = (name: string) => Promise<GroupAnswer>

/**
 * Kanidm answers `null` for a group that does not exist and for one the token may not read; both
 * mean the app cannot share with it, so both are "missing". Anything else (network, a refused
 * token) is "unavailable": the admin is told to try again, the rule is not stored.
 */
export function createGroupLookup(options: KanidmClientOptions): GroupLookup {
  const client = createKanidmClient(options)
  return async (name) => {
    const result = await client.readGroup(name)
    if (result.ok) return 'exists'
    return result.failure.kind === 'null-answer' ? 'missing' : 'unavailable'
  }
}
