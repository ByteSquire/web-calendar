import { readBody, setResponseStatus } from 'h3'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { apiConfig } from '../../../utils/api/config'
import { expectValid } from '../../../utils/api/validation'
import { importCandidate } from '../../../utils/groups/oidc'
import { getGroupsPorts } from '../../../utils/groups/ports'
import { parseOidcImport } from '../../../utils/groups/rules'
import { groupSummary } from '../../../utils/groups/service'

// Imports a group of the identity provider (admins only). It starts without members; people join
// it as they sign in.
export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const { externalId } = expectValid(parseOidcImport(await readBody(event)))
  const { adminGroup, groupsIgnore } = apiConfig()
  const group = atomic(() => {
    const imported = importCandidate(db, externalId, { ignore: groupsIgnore, adminGroup })
    audit('group.oidc_imported', `group:${imported.id}`, {
      groupId: imported.id,
      name: imported.name,
    })
    return imported
  })
  getGroupsPorts().onGroupsChanged()
  setResponseStatus(event, 201)
  return { group: groupSummary({ ...group, memberCount: 0, member: false, manager: false }) }
})
