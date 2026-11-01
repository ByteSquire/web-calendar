import { getRouterParam, readBody, setResponseStatus } from 'h3'
import { defineApiHandler } from '../../../utils/api/handler'
import { expectValid, parseId } from '../../../utils/api/validation'
import { actorOf } from '../../../utils/resources/caller'
import { bookingDto } from '../../../utils/resources/dto'
import { parseBookingInput } from '../../../utils/resources/input'
import { depsOf, takeBookingToken, unwrap } from '../../../utils/resources/http'
import { requestBooking } from '../../../utils/resources/service'

export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  takeBookingToken(event, user.sub)
  const input = expectValid(parseBookingInput(await readBody(event), id))
  const { booking } = unwrap(
    await requestBooking(depsOf(event, db), await actorOf(event, user), input),
  )
  setResponseStatus(event, 201)
  return bookingDto(db, booking, false)
})
