import { getRouterParam, readBody } from 'h3'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { expectValid, parseId } from '../../../utils/api/validation'
import { loadGroup } from '../../../utils/groups/http'
import { parseManagersBody } from '../../../utils/groups/rules'
import { listGroupMembers } from '../../../db/groups'
import { replaceManagers, memberView } from '../../../utils/groups/service'

// Makes the members given the managers of the group, and no others (admins only). Managers change
// the members of an app group and the group's calendars; nothing in Radicale changes.
export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const group = loadGroup(db, parseId(getRouterParam(event, 'id')))
  const subs = expectValid(parseManagersBody(await readBody(event)))
  atomic(() => {
    const changed = replaceManagers(db, group, subs)
    if (changed.added + changed.removed > 0) {
      audit('group.managers_replaced', `group:${group.id}`, {
        groupId: group.id,
        added: changed.added,
        removed: changed.removed,
        total: changed.total,
      })
    }
  })
  return { members: listGroupMembers(db, group.id).map(memberView) }
})
