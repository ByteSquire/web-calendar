// The groups of the caller as resource rules need them: short Kanidm group names from userinfo.
import type { H3Event } from 'h3'
import { apiConfig } from '../api/config'
import { bearerToken } from '../api/me'
import type { ApiUser } from '../api/handler'
import { tokenExpiresAtMs } from '../api/userinfo-client'
import { getUserinfoClient } from '../api/userinfo-service'
import { isGroupName } from '../groups/htgroup'
import type { Actor } from './service'

/** `calendar_admins@idm.example.org` -> `calendar_admins`; names that are not group names drop out. */
export function shortGroupNames(groups: readonly string[]): string[] {
  const names = new Set<string>()
  for (const group of groups) {
    const name = group.split('@')[0] ?? ''
    if (isGroupName(name)) names.add(name)
  }
  return [...names].sort()
}

/**
 * The caller with their groups. When userinfo does not answer the groups are empty: the caller then
 * has only what `authenticated` rules give, never more.
 */
export async function actorOf(event: H3Event, user: ApiUser): Promise<Actor> {
  const accessToken = bearerToken(event.headers)
  const result = await getUserinfoClient().get({
    issuer: apiConfig().oidcIssuer,
    sub: user.sub,
    accessToken,
    tokenExpiresAtMs: tokenExpiresAtMs(accessToken),
    groupsClaim: apiConfig().groupsClaim,
  })
  const groups = result.ok ? shortGroupNames(result.profile.groups ?? []) : []
  return { id: user.id, sub: user.sub, groups }
}
