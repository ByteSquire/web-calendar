import { getQuery } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid, FieldErrors, finish } from '../../utils/api/validation'
import { actorOf } from '../../utils/resources/caller'
import { readInstantParam } from '../../utils/resources/availability'
import { listBookingUpdates } from '../../utils/resources/updates'

// The caller's own bookings that were decided or cancelled after `since`.
export default defineApiHandler(async (event, { db, user }) => {
  const errors = new FieldErrors()
  const since = readInstantParam(getQuery(event).since, 'since', errors)
  const valid = expectValid(finish(errors, () => since!))
  return listBookingUpdates(db, await actorOf(event, user), valid)
})
