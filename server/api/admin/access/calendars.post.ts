import { readBody, setResponseStatus } from 'h3'
import { getAccessCalendar } from '../../../utils/access/service'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { expectValid } from '../../../utils/api/validation'
import { calendarContextOf } from '../../../utils/calendars/manage'
import { createOrganizationCalendar } from '../../../utils/calendars/organization'
import { parseCalendarCreate } from '../../../utils/groups/rules'

// A calendar of the organization (admins only): it belongs to no person and no group, and nobody
// sees it until an access rule shares it.
export default defineAdminHandler(async (event, ctx) => {
  const fields = expectValid(parseCalendarCreate(await readBody(event)))
  const row = await createOrganizationCalendar(calendarContextOf(ctx), fields)
  setResponseStatus(event, 201)
  return { calendar: found(getAccessCalendar(ctx.db, row.id)) }
})
