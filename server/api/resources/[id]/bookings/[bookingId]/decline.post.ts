import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/api/handler'
import { parseId } from '../../../../../utils/api/validation'
import { actorOf } from '../../../../../utils/resources/caller'
import { bookingDto } from '../../../../../utils/resources/dto'
import { depsOf, requireBookingOf, unwrap } from '../../../../../utils/resources/http'
import { declineBooking } from '../../../../../utils/resources/service'

export default defineApiHandler(async (event, { db, user }) => {
  const resourceId = parseId(getRouterParam(event, 'id'))
  const bookingId = parseId(getRouterParam(event, 'bookingId'))
  requireBookingOf(db, resourceId, bookingId)
  const result = unwrap(
    await declineBooking(depsOf(event, db), await actorOf(event, user), bookingId),
  )
  const manager = result.booking.requester_id !== user.id
  return {
    booking: bookingDto(db, result.booking, manager),
  }
})
