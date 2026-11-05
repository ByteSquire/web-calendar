// Where the groups of a person come from at a sign-in: the identity provider's userinfo answer, or
// the verified access token when userinfo cannot say. Pure; the decision is the whole file.
import type { UserinfoResult } from '../api/userinfo'

/** The groups claim of a signature-verified access token (see the verifier). */
export interface TokenGroups {
  /** The entries of the claim, or undefined when the token has none. */
  entries: string[] | undefined
  /**
   * The token says its groups were left out because there are too many (Entra, `_claim_names`):
   * they are unknown, which is not the same as none.
   */
  overage: boolean
}

export type GroupsChoice =
  /** `entries` undefined: the source used has no groups claim, so nothing is known. */
  | { ok: true; entries: string[] | undefined; from: 'userinfo' | 'token' }
  /** The groups cannot be trusted this time: stored memberships stay, the person is not an admin. */
  | { ok: false }

/**
 * Userinfo first, always: it is the provider's current answer about this person. The verified
 * token's claim is used only where userinfo cannot give groups at all:
 * - the provider publishes no userinfo endpoint, or the answer (200) has no groups claim;
 * - or the endpoint is on another origin than the issuer and refuses the token (401 or 403): Entra's
 *   userinfo is Microsoft Graph, which takes only a Graph token and never has groups.
 * A 401 from the issuer's own origin is not a case for the token: Kanidm revokes a token there, and
 * the token alone would still verify. Network errors, timeouts, 5xx and bad answers also leave the
 * groups unknown (fail closed). The token's claim is as fresh as the token (its lifetime).
 */
export function chooseGroups(result: UserinfoResult, token: TokenGroups | undefined): GroupsChoice {
  const fromToken = (): GroupsChoice => ({
    ok: true,
    entries: token && !token.overage ? token.entries : undefined,
    from: 'token',
  })
  if (result.ok) {
    return result.profile.groups !== undefined
      ? { ok: true, entries: result.profile.groups, from: 'userinfo' }
      : fromToken()
  }
  if (result.reason === 'no-endpoint') return fromToken()
  if (
    result.reason === 'status' &&
    (result.status === 401 || result.status === 403) &&
    result.otherOrigin === true
  ) {
    return fromToken()
  }
  return { ok: false }
}
