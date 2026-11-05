import { getRouterParam, readBody } from 'h3'
import { defineMemberHandler } from '../../../../../utils/api/member-handler'
import { expectValid, parseId } from '../../../../../utils/api/validation'
import { replaceGroupCalendarShares } from '../../../../../utils/groups/calendars'
import { parseSharesBody } from '../../../../../utils/groups/rules'
import { loadGroup, requireMemberOrAdmin, calendarContext } from '../../../../../utils/groups/http'

// Replaces the extra shares of a calendar of the group (members and admins). The owning group's
// write rule stays as it is.
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireMemberOrAdmin(ctx, group)
  const shares = expectValid(parseSharesBody(await readBody(event)))
  const calendar = replaceGroupCalendarShares(
    calendarContext(ctx),
    group,
    parseId(getRouterParam(event, 'calendarId')),
    shares,
  )
  return { calendar }
})
