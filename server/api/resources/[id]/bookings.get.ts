import { getRouterParam } from 'h3'
import { found } from '../../../utils/api/errors'
import { defineApiHandler } from '../../../utils/api/handler'
import { parseId } from '../../../utils/api/validation'
import { actorOf } from '../../../utils/resources/caller'
import { bookingDto } from '../../../utils/resources/dto'
import { listBookingsFor } from '../../../utils/resources/service'

// The caller's own bookings of the resource; a manager gets all of them.
export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const list = found(listBookingsFor(db, await actorOf(event, user), id))
  return { bookings: list.bookings.map((booking) => bookingDto(db, booking, list.manager)) }
})
