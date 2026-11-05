import { getRouterParam } from 'h3'
import { deleteCalendarLink } from '../../db/calendar-links'
import { notFound } from '../../utils/api/errors'
import { defineMemberHandler } from '../../utils/api/member-handler'
import { parseId } from '../../utils/api/validation'

// Withdraws one of the caller's links: the address stops working at once, open pages too (every read
// looks the link up). Another person's link answers 404, as one that does not exist.
export default defineMemberHandler((event, { db, user, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const removed = atomic(() => {
    const row = deleteCalendarLink(db, user.id, id)
    if (!row) throw notFound()
    audit('calendar_link.deleted', `calendar_link:${row.id}`, {
      linkId: row.id,
      calendar: row.collectionPath,
      label: row.label,
    })
    return row
  })
  return { removed: { id: removed.id } }
})
