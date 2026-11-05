import { getRouterParam, readBody } from 'h3'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { expectValid, parseId } from '../../../utils/api/validation'
import { loadGroup } from '../../../utils/groups/http'
import { parseMembersBody } from '../../../utils/groups/rules'
import { listGroupMembers } from '../../../db/groups'
import { replaceMembers, personView } from '../../../utils/groups/service'
import { getGroupsPorts } from '../../../utils/groups/ports'

// Replaces the members of an app group with the list given (admins only; a Kanidm group is read-only).
export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const group = loadGroup(db, parseId(getRouterParam(event, 'id')))
  const subs = expectValid(parseMembersBody(await readBody(event)))
  const counts = atomic(() => {
    const changed = replaceMembers(db, group, subs)
    audit('group.members_replaced', `group:${group.id}`, {
      groupId: group.id,
      added: changed.added,
      removed: changed.removed,
      total: changed.total,
    })
    return changed
  })
  if (counts.added + counts.removed > 0) getGroupsPorts().onGroupsChanged()
  return { members: listGroupMembers(db, group.id).map(personView) }
})
