// Maps the member SPNs Kanidm lists (`alice@idm.example.org`) to the `sub` UUIDs the group file
// needs, by asking Kanidm for each person's `uuid` (the OIDC `sub`). The sync account needs
// `idm_people_pii_read` for that (docs/kanidm-setup.md §3); without it every answer is `null`.
//
// Kanidm is asked on every run and nothing is cached: names can be renamed and given to someone
// else, and only the `uuid` is stable (Kanidm: "You MUST use the uuid attribute ... as an external
// primary key"). An earlier version mapped names through the app's `users` table, which is only
// updated at sign-in, so a reused name could map to its previous holder (security review
// 2026-11-01 §5).
//
// A member Kanidm answers `null` for is not an error: a service account or a nested group is not a
// person. It is reported as `pending` and left out of the file; the caller decides what that means
// (service.ts). Any other failure fails the whole resolution, so the run keeps the old file.
import type { KanidmClient } from './kanidm'
import type { Result } from './types'

export interface MemberResolution {
  /** SPN -> `sub` for every member that is a person the token can read. */
  uuids: Map<string, string>
  /** The members with no UUID, in the order they were asked for. */
  pending: string[]
}

export type MemberResolver = (spns: string[]) => Promise<Result<MemberResolution>>

/** Requests to Kanidm in flight at once during one resolution. */
export const PERSON_LOOKUP_CONCURRENCY = 8

export function createKanidmResolver(
  client: Pick<KanidmClient, 'readPersonUuid'>,
  concurrency = PERSON_LOOKUP_CONCURRENCY,
): MemberResolver {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`)
  }
  return async (spns) => {
    const uuids = new Map<string, string>()
    const pending: string[] = []
    for (let start = 0; start < spns.length; start += concurrency) {
      const batch = spns.slice(start, start + concurrency)
      const answers = await Promise.all(batch.map((spn) => client.readPersonUuid(spn)))
      for (const [i, answer] of answers.entries()) {
        if (!answer.ok) return answer
        const spn = batch[i]!
        if (answer.value === null) pending.push(spn)
        else uuids.set(spn, answer.value)
      }
    }
    return { ok: true, value: { uuids, pending } }
  }
}
