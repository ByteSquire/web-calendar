import { getRouterParam, readBody, setResponseStatus } from 'h3'
import { defineMemberHandler } from '../../../../utils/api/member-handler'
import { expectValid, parseId } from '../../../../utils/api/validation'
import { createGroupCalendar } from '../../../../utils/groups/calendars'
import { parseCalendarCreate } from '../../../../utils/groups/rules'
import { loadGroup, requireManagerOrAdmin, calendarContext } from '../../../../utils/groups/http'

// A calendar the group owns, created in Radicale under the group's principal. Managers and admins.
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireManagerOrAdmin(ctx, group)
  const fields = expectValid(parseCalendarCreate(await readBody(event)))
  const calendar = await createGroupCalendar(calendarContext(ctx), group, fields)
  setResponseStatus(event, 201)
  return { calendar }
})
