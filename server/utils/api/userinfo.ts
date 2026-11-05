// The OIDC userinfo call behind GET /api/me (design §6): the profile and the groups of the caller,
// which Kanidm puts in the userinfo response and not in the access token. The endpoint is the one
// in the provider's discovery document. A pure function that takes `fetch`, so tests need no
// network.
import { claimEntries } from '../groups/claim'

const DEFAULT_TIMEOUT_MS = 3000
/** A userinfo answer is a few hundred bytes; anything bigger is not from an identity provider. */
const MAX_RESPONSE_CHARS = 64 * 1024

export interface UserinfoProfile {
  sub: string
  username?: string
  name?: string
  email?: string
  /**
   * The entries of the groups claim (`NUXT_OIDC_GROUPS_CLAIM`): names, SPNs, ids or paths, whatever
   * the provider writes. Undefined when the claim is missing, which is not the same as "member of
   * no group": the token may simply not carry a groups scope.
   */
  groups?: string[]
}

export type UserinfoFailure =
  /** The provider publishes no userinfo endpoint, or its discovery document is not known yet. */
  | 'no-endpoint'
  | 'no-token'
  | 'timeout'
  | 'network'
  | 'status'
  | 'too-large'
  | 'bad-json'
  | 'bad-shape'
  | 'sub-mismatch'

export type UserinfoResult =
  | { ok: true; profile: UserinfoProfile }
  | {
      ok: false
      reason: UserinfoFailure
      status?: number
      /**
       * Set by the userinfo client on a `status` failure when the endpoint is on another origin than
       * the issuer (Entra: Microsoft Graph, which takes only a Graph token). Then a refusal of the
       * caller's token says nothing about the token; see `chooseGroups`.
       */
      otherOrigin?: boolean
    }

export interface UserinfoRequest {
  /**
   * The `userinfo_endpoint` of the issuer's discovery document, which was checked to be https for an
   * https issuer; null when there is none. Nothing is derived from the issuer.
   */
  endpoint: string | null
  /** The caller's own access token. It is only sent to the endpoint and never logged or kept. */
  accessToken: string | null
  /** The `sub` of the verified token. Userinfo about anybody else is ignored. */
  expectedSub: string
  fetch: typeof fetch
  timeoutMs?: number
  /** The claim the groups are in (`NUXT_OIDC_GROUPS_CLAIM`); `groups` when not given. */
  groupsClaim?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Asks the identity provider about the caller. Never throws: a slow, failing or odd answer comes
 * back as `{ ok: false, reason }` and the caller falls back to what is stored.
 */
export async function fetchUserinfo(request: UserinfoRequest): Promise<UserinfoResult> {
  if (!request.endpoint) return { ok: false, reason: 'no-endpoint' }
  if (!request.accessToken) return { ok: false, reason: 'no-token' }

  const url = request.endpoint
  const groupsClaim = request.groupsClaim ?? 'groups'
  const controller = new AbortController()
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  // The race also covers a fetch that ignores the abort signal.
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })

  async function load(): Promise<UserinfoResult> {
    let response: Response
    try {
      response = await request.fetch(url, {
        headers: { authorization: `Bearer ${request.accessToken}`, accept: 'application/json' },
        // The token must not follow a redirect to somewhere the operator did not configure.
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' }
    }
    if (response.status !== 200) {
      return { ok: false, reason: 'status', status: response.status }
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' }
    }
    if (text.length > MAX_RESPONSE_CHARS) return { ok: false, reason: 'too-large' }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'bad-json' }
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return { ok: false, reason: 'bad-shape' }
    }
    const claims = json as Record<string, unknown>
    if (typeof claims.sub !== 'string') return { ok: false, reason: 'bad-shape' }
    if (claims.sub !== request.expectedSub) return { ok: false, reason: 'sub-mismatch' }

    return {
      ok: true,
      profile: {
        sub: claims.sub,
        username: optionalString(claims.preferred_username),
        name: optionalString(claims.name),
        email: optionalString(claims.email),
        groups: claimEntries(Object.hasOwn(claims, groupsClaim) ? claims[groupsClaim] : undefined),
      },
    }
  }

  try {
    return await Promise.race([
      load(),
      timedOut.then((): UserinfoResult => ({ ok: false, reason: 'timeout' })),
    ])
  } finally {
    clearTimeout(timer)
  }
}
