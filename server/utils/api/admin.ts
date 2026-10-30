// The one admin check (L1). Whether somebody is an admin is decided by the identity provider, per
// request: the caller's own token is held against userinfo and the `groups` claim must name the
// admin group. Anything else - userinfo down, an answer without `groups`, another group - is "not
// an admin". `users.is_admin` is a note for display and never takes part in this decision.
import type { UserinfoClient } from './userinfo-client'
import { isAdminByGroups } from './userinfo'

export type AdminDecision =
  | { admin: true }
  | { admin: false; reason: 'userinfo-unavailable' | 'no-groups-claim' | 'not-in-group' }

export interface AdminCheck {
  userinfo: UserinfoClient
  issuer: string
  adminGroup: string
  sub: string
  accessToken: string | null
  tokenExpiresAtMs?: number | null
}

/** Fresh: a group change takes effect at once. Only a call already running is joined. */
export async function decideAdmin(check: AdminCheck): Promise<AdminDecision> {
  const result = await check.userinfo.get(
    {
      issuer: check.issuer,
      sub: check.sub,
      accessToken: check.accessToken,
      tokenExpiresAtMs: check.tokenExpiresAtMs,
    },
    { maxAgeMs: 0 },
  )
  if (!result.ok) return { admin: false, reason: 'userinfo-unavailable' }
  if (!result.profile.groups) return { admin: false, reason: 'no-groups-claim' }
  return isAdminByGroups(result.profile.groups, check.adminGroup)
    ? { admin: true }
    : { admin: false, reason: 'not-in-group' }
}
