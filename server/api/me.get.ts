import { apiConfig } from '../utils/api/config'
import { defineApiHandler } from '../utils/api/handler'
import { bearerToken, resolveMe } from '../utils/api/me'
import { afterGroupImport } from '../utils/groups/ports'
import { tokenExpiresAtMs } from '../utils/api/userinfo-client'
import { getUserinfoClient } from '../utils/api/userinfo-service'

// The app user of the caller (FR-13), with the profile and the admin flag from userinfo. Userinfo
// answers are kept for a minute per user (L5); `requireAdmin` does not use that memory.
export default defineApiHandler((event, { db, user, identity }) => {
  const { oidcIssuer, adminGroup, groupsClaim, groupsIgnore } = apiConfig()
  return resolveMe(
    {
      db,
      adminGroup,
      groupsIgnore,
      onGroupsImported: afterGroupImport,
      userinfo: (sub, accessToken) =>
        getUserinfoClient().get({
          issuer: oidcIssuer,
          sub,
          accessToken,
          tokenExpiresAtMs: tokenExpiresAtMs(accessToken),
          groupsClaim,
        }),
      warn: (message) => console.warn(message),
    },
    user,
    bearerToken(event.headers),
    identity.tokenGroups,
  )
})
