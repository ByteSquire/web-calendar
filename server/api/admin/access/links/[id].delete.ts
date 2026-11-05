import { getRouterParam } from 'h3'
import { deleteCalendarLink, findCalendarLinkById } from '../../../../db/calendar-links'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { notFound } from '../../../../utils/api/errors'
import { parseId } from '../../../../utils/api/validation'

// Removes a link to a calendar of the access page, whoever made it. Its address stops at once.
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  atomic(() => {
    const link = findCalendarLinkById(db, id)
    if (!link || link.calendar_id === null) throw notFound()
    deleteCalendarLink(db, id)
    audit('calendar_link.deleted', `calendar_link:${id}`, {
      linkId: id,
      calendarId: link.calendar_id,
      label: link.label,
      byAdmin: true,
    })
  })
  return { removed: { id } }
})
