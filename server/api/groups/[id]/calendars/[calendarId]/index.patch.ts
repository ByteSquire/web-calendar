import { getRouterParam, readBody } from 'h3'
import { defineMemberHandler } from '../../../../../utils/api/member-handler'
import { expectValid, parseId } from '../../../../../utils/api/validation'
import { updateGroupCalendar } from '../../../../../utils/groups/calendars'
import { parseCalendarPatch } from '../../../../../utils/groups/rules'
import { loadGroup, requireMemberOrAdmin, calendarContext } from '../../../../../utils/groups/http'

// Renames or recolours a calendar of the group (members and admins).
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireMemberOrAdmin(ctx, group)
  const fields = expectValid(parseCalendarPatch(await readBody(event)))
  const calendar = await updateGroupCalendar(
    calendarContext(ctx),
    group,
    parseId(getRouterParam(event, 'calendarId')),
    fields,
  )
  return { calendar }
})
