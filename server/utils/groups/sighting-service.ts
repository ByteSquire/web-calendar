// The process-wide sighting tracker of the CalDAV gateway: what a due sighting does with the
// server's database, userinfo client and settings. The rules are in `sighting.ts`.
import type { Identity } from '../auth/authenticate'
import { upsertUser } from '../../db/users'
import { apiConfig } from '../api/config'
import { bearerToken, resolveMe } from '../api/me'
import { tokenExpiresAtMs } from '../api/userinfo-client'
import { getUserinfoClient } from '../api/userinfo-service'
import { getDb } from '../db'
import { noteActiveUser } from './file-trigger'
import { afterGroupImport } from './ports'
import { createSightingTracker, type SightingTracker } from './sighting'
import type { TokenGroups } from './source'

let tracker: SightingTracker | undefined

async function refresh(
  sub: string,
  accessToken: string,
  tokenGroups: TokenGroups | undefined,
): Promise<void> {
  const db = getDb()
  const { oidcIssuer, adminGroup, groupsClaim, groupsIgnore } = apiConfig()
  // The person may never have opened the web app: this creates their row, and renews the window.
  const user = upsertUser(db, { sub })
  noteActiveUser(sub)
  await resolveMe(
    {
      db,
      adminGroup,
      groupsIgnore,
      onGroupsImported: afterGroupImport,
      userinfo: (who, token) =>
        getUserinfoClient().get({
          issuer: oidcIssuer,
          sub: who,
          accessToken: token,
          tokenExpiresAtMs: tokenExpiresAtMs(token),
          groupsClaim,
        }),
      warn: (message) => console.warn(message),
    },
    user,
    accessToken,
    tokenGroups,
  )
}

/**
 * Called by the gateway for every authenticated request. An OIDC bearer call records the person as
 * seen and refreshes their groups in the background (see `createSightingTracker`); an app-token call
 * does nothing, so a token cannot keep its own owner active.
 */
export function noteBearerSighting(identity: Identity, headers: Headers): void {
  if (identity.via !== 'bearer') return
  const token = bearerToken(headers)
  if (token === null) return
  tracker ??= createSightingTracker({
    refresh,
    onError: (error) =>
      // The message of a database or network error; the token is not part of any of them.
      console.warn(
        `[gateway] the sighting of a person was not recorded: ${error instanceof Error ? error.message : 'unexpected error'}`,
      ),
  })
  tracker.note(identity.sub, token, identity.tokenGroups)
}
