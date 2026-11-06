import { getRouterParam } from 'h3'
import { defineMemberHandler } from '../../../../../utils/api/member-handler'
import { parseId } from '../../../../../utils/api/validation'
import { deleteGroupCalendar } from '../../../../../utils/groups/calendars'
import { loadGroup, requireManagerOrAdmin, calendarContext } from '../../../../../utils/groups/http'

// Deletes a calendar of the group: its collection in Radicale, its rows and its shares (managers and
// admins).
export default defineMemberHandler(async (event, ctx) => {
  const group = loadGroup(ctx.db, parseId(getRouterParam(event, 'id')))
  await requireManagerOrAdmin(ctx, group)
  await deleteGroupCalendar(
    calendarContext(ctx),
    group,
    parseId(getRouterParam(event, 'calendarId')),
  )
  return {}
})
