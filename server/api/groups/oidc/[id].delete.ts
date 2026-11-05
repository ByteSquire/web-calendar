import { getRouterParam } from 'h3'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { parseId } from '../../../utils/api/validation'
import { loadGroup } from '../../../utils/groups/http'
import { stopImporting } from '../../../utils/groups/oidc'
import { getGroupsPorts } from '../../../utils/groups/ports'

// Stops importing a group (admins only): the group, its members and the rules that name it go; it
// can be imported again later. Refused with 409 while the group owns calendars.
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const group = loadGroup(db, parseId(getRouterParam(event, 'id')))
  const removed = atomic(() => {
    const counts = stopImporting(db, group)
    audit('group.oidc_import_stopped', `group:${group.id}`, {
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
