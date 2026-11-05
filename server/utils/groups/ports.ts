// What the group routes need from the running server: the Radicale client (group calendars live
// there) and the two triggers that make the group file and the shares follow a change. Tests set
// their own; the server builds the client from NUXT_RADICALE_URL on first use.
import { requestGroupFileWrite } from './file-trigger'
import { createRadicaleClient, type RadicaleClient } from '../sharing/radicale-client'
import { requestSharingReconcile } from '../sharing'
import { ApiError } from '../api/errors'
import type { ImportOutcome } from './import'

export interface GroupsPorts {
  radicale(): RadicaleClient
  /** A change to the groups or their members: the group file is rewritten soon. */
  onGroupsChanged(): void
  /** A change to calendars or shares: Radicale's shares follow soon. */
  onSharesChanged(): void
}

let override: GroupsPorts | undefined
let defaults: GroupsPorts | undefined

export function setGroupsPorts(next: GroupsPorts | undefined): void {
  override = next
}

export function getGroupsPorts(): GroupsPorts {
  if (override) return override
  defaults ??= {
    radicale() {
      const url = String(useRuntimeConfig().radicale.url ?? '').trim()
      try {
        return createRadicaleClient({ baseUrl: url })
      } catch {
        throw new ApiError(502, 'The calendar server is not configured', {
          code: 'upstream_unavailable',
        })
      }
    },
    onGroupsChanged: () => requestGroupFileWrite(),
    onSharesChanged: () => requestSharingReconcile(),
  }
  return defaults
}

/** After groups were imported at a sign-in: the group file follows a change; shares follow a rename. */
export function afterGroupImport(outcome: ImportOutcome): void {
  const ports = getGroupsPorts()
  if (outcome.membershipsChanged || outcome.renamed > 0) ports.onGroupsChanged()
  if (outcome.renamed > 0) ports.onSharesChanged()
}
