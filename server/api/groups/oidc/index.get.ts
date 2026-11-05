import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { apiConfig } from '../../../utils/api/config'
import { listCandidates } from '../../../utils/groups/oidc'

// The groups the identity provider's claim has shown at sign-ins, for an admin to pick from. A
// candidate grants nothing; only an imported group has members.
export default defineAdminHandler((_event, { db }) => {
  const { adminGroup, groupsIgnore } = apiConfig()
  return listCandidates(db, { ignore: groupsIgnore, adminGroup })
})
