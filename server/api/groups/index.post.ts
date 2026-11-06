import { readBody, setResponseStatus } from 'h3'
import { defineAdminHandler } from '../../utils/api/admin-handler'
import { apiConfig } from '../../utils/api/config'
import { expectValid } from '../../utils/api/validation'
import { parseGroupCreate } from '../../utils/groups/rules'
import { createCustomGroup, groupSummary } from '../../utils/groups/service'
import { getGroupsPorts } from '../../utils/groups/ports'

// Creates an app group (admins only). The name must be free of both sources and of the reserved names.
export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const { name } = expectValid(parseGroupCreate(await readBody(event)))
  const group = atomic(() => {
    const created = createCustomGroup(db, name, apiConfig().adminGroup)
    audit('group.created', `group:${created.id}`, { groupId: created.id, name: created.name })
    return created
  })
  getGroupsPorts().onGroupsChanged()
  setResponseStatus(event, 201)
  return { group: groupSummary({ ...group, memberCount: 0, member: false, manager: false }) }
})
