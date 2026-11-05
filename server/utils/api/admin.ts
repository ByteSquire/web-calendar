// The one admin check (L1). Whether somebody is an admin is decided by the identity provider, per
// request: the caller's own token is held against userinfo and the `groups` claim must name the
// admin group. Anything else - userinfo down, an answer without `groups`, another group - is "not
// an admin". `users.is_admin` is a note for display and never takes part in this decision.
import { matchesAdminGroup } from '../groups/claim'
import { chooseGroups, type TokenGroups } from '../groups/source'
import type { UserinfoClient } from './userinfo-client'

export type AdminDecision =
  | { admin: true }
  | { admin: false; reason: 'userinfo-unavailable' | 'no-groups-claim' | 'not-in-group' }

export interface AdminCheck {
  userinfo: UserinfoClient
  issuer: string
  adminGroup: string
  sub: string
  /** The claim the groups are in (`NUXT_OIDC_GROUPS_CLAIM`). */
  groupsClaim?: string
  accessToken: string | null
  tokenExpiresAtMs?: number | null
  /** The groups claim of the verified token: used only where userinfo cannot give groups. */
  tokenGroups?: TokenGroups
}

/** Fresh: a group change takes effect at once. Only a call already running is joined. */
export async function decideAdmin(check: AdminCheck): Promise<AdminDecision> {
  const result = await check.userinfo.get(
    {
      issuer: check.issuer,
      sub: check.sub,
      accessToken: check.accessToken,
      tokenExpiresAtMs: check.tokenExpiresAtMs,
      groupsClaim: check.groupsClaim,
    },
    { maxAgeMs: 0 },
  )
  const groups = chooseGroups(result, check.tokenGroups)
  if (!groups.ok) return { admin: false, reason: 'userinfo-unavailable' }
  if (!groups.entries) return { admin: false, reason: 'no-groups-claim' }
  return matchesAdminGroup(groups.entries, check.adminGroup)
    ? { admin: true }
    : { admin: false, reason: 'not-in-group' }
}
