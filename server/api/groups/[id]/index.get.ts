import { getRouterParam } from 'h3'
import { defineMemberHandler } from '../../../utils/api/member-handler'
import { parseId } from '../../../utils/api/validation'
import { loadGroup, requireMemberOrAdmin } from '../../../utils/groups/http'
import { groupDetail } from '../../../utils/groups/service'

// One group for its members and for admins; anybody else gets 403. Members are shown by name only.
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireMemberOrAdmin(ctx, group)
  // Only an app group's members can be changed, and only by an admin.
  const canManageMembers = group.source === 'app' && (await ctx.isAdmin())
  return groupDetail(ctx.db, group, canManageMembers)
})
