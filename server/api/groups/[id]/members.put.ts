import { getRouterParam, readBody } from 'h3'
import { defineMemberHandler } from '../../../utils/api/member-handler'
import { expectValid, parseId } from '../../../utils/api/validation'
import { loadGroup, requireManagerOrAdmin } from '../../../utils/groups/http'
import { parseMembersBody } from '../../../utils/groups/rules'
import { listGroupMembers } from '../../../db/groups'
import { replaceMembers, memberView } from '../../../utils/groups/service'
import { getGroupsPorts } from '../../../utils/groups/ports'

// Replaces the members of an app group with the list given (its managers and admins; a group of the
// identity provider is read-only). Only an admin may remove a manager.
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireManagerOrAdmin(ctx, group)
  const subs = expectValid(parseMembersBody(await readBody(event)))
  const byAdmin = await ctx.isAdmin()
  const counts = ctx.atomic(() => {
    const changed = replaceMembers(ctx.db, group, subs, byAdmin)
    ctx.audit('group.members_replaced', `group:${group.id}`, {
      groupId: group.id,
      added: changed.added,
      removed: changed.removed,
      total: changed.total,
    })
    return changed
  })
  if (counts.added + counts.removed > 0) getGroupsPorts().onGroupsChanged()
  return { members: listGroupMembers(ctx.db, group.id).map(memberView) }
})
