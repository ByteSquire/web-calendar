import { getRouterParam } from 'h3'
import { findCalendarById } from '../../../../db/calendars'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { ApiError, found } from '../../../../utils/api/errors'
import { parseId } from '../../../../utils/api/validation'
import {
  calendarContextOf,
  deleteCalendar,
  refuseDefaultCalendar,
} from '../../../../utils/calendars/manage'

// Deletes any calendar but a resource's (admins only): its shares and collection in Radicale, its
// rules, and its links. A resource's calendar goes with the resource (Admin › Resources), and a
// person's default calendar is kept (409 `default_calendar`).
export default defineAdminHandler(async (event, ctx) => {
  const id = parseId(getRouterParam(event, 'id'))
  const row = found(findCalendarById(ctx.db, id))
  if (row.kind === 'resource') {
    throw new ApiError(409, 'A resource calendar is removed with its resource', {
      code: 'resource',
    })
  }
  if (row.kind === 'personal') refuseDefaultCalendar(row.collection_path)
  await deleteCalendar(calendarContextOf(ctx), row.collection_path, row, (links) =>
    ctx.audit('calendar.deleted', `calendar:${id}`, {
      name: row.name,
      kind: row.kind,
      groupId: row.group_id,
      links,
    }),
  )
  return {}
})
