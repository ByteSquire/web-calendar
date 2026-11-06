import { getRouterParam, readBody } from 'h3'
import { findCalendarById } from '../../../../db/calendars'
import { getAccessCalendar } from '../../../../utils/access/service'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { found } from '../../../../utils/api/errors'
import { expectValid, parseId } from '../../../../utils/api/validation'
import { calendarContextOf, changeCalendar } from '../../../../utils/calendars/manage'
import { parseCalendarPatch } from '../../../../utils/groups/rules'

// Renames or recolours any calendar (admins only), in Radicale as the principal that owns it and in
// its row. The colour is the calendar's own; a person's own choice (calendar-prefs) stays theirs.
export default defineAdminHandler(async (event, ctx) => {
  const id = parseId(getRouterParam(event, 'id'))
  const current = found(findCalendarById(ctx.db, id))
  const input = expectValid(parseCalendarPatch(await readBody(event)))
  await changeCalendar(calendarContextOf(ctx), current, input, (row, colorCleared) =>
    ctx.audit('calendar.changed', `calendar:${id}`, { name: row.name, colorCleared }),
  )
  return { calendar: found(getAccessCalendar(ctx.db, id)) }
})
