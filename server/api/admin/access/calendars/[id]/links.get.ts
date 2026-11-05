import { getRouterParam } from 'h3'
import { listCalendarLinksOfCalendar } from '../../../../../db/calendar-links'
import { defineAdminHandler } from '../../../../../utils/api/admin-handler'
import { apiConfig } from '../../../../../utils/api/config'
import { found } from '../../../../../utils/api/errors'
import { parseId } from '../../../../../utils/api/validation'
import { getCalendarRow } from '../../../../../utils/access/service'
import { linkView } from '../../../../../utils/links/service'

// Every link to a calendar of the access page: the ones admins made here and the ones people made
// in Settings to it, with their addresses (the password is asked for one at a time).
export default defineAdminHandler((event, { db }) => {
  const id = parseId(getRouterParam(event, 'id'))
  found(getCalendarRow(db, id))
  const { tokenHashKey } = apiConfig()
  return { links: listCalendarLinksOfCalendar(db, id).map((link) => linkView(tokenHashKey, link)) }
})
