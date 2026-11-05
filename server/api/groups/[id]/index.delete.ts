import { getRouterParam } from 'h3'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { parseId } from '../../../utils/api/validation'
import { loadGroup } from '../../../utils/groups/http'
import { deleteCustomGroup } from '../../../utils/groups/service'
import { getGroupsPorts } from '../../../utils/groups/ports'

// Deletes an app group that owns no calendar (admins only), with the rules that name it.
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const group = loadGroup(db, parseId(getRouterParam(event, 'id')))
  const removed = atomic(() => {
    const counts = deleteCustomGroup(db, group)
    audit('group.deleted', `group:${group.id}`, {
      groupId: group.id,
      name: group.name,
      calendarRules: counts.calendarRules,
      resourceRules: counts.resourceRules,
    })
    return counts
  })
  getGroupsPorts().onGroupsChanged()
  getGroupsPorts().onSharesChanged()
  return { removed }
})
