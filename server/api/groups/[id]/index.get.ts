import { getRouterParam } from 'h3'
import { isGroupManager } from '../../../db/groups'
import { defineMemberHandler } from '../../../utils/api/member-handler'
import { parseId } from '../../../utils/api/validation'
import { loadGroup, requireMemberOrAdmin } from '../../../utils/groups/http'
import { groupDetail, groupRights } from '../../../utils/groups/service'

// One group for its members and for admins; anybody else gets 403. Members are shown by name only,
// with whether they manage the group; the rights say what the caller may change (the routes check).
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireMemberOrAdmin(ctx, group)
  const manager = isGroupManager(ctx.db, group.id, ctx.identity.sub)
  return groupDetail(ctx.db, group, groupRights(group, manager, await ctx.isAdmin()))
})
