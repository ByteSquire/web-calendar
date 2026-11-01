import { getQuery } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid } from '../../utils/api/validation'
import { listAvailability, parseAvailabilityQuery } from '../../utils/resources/availability'
import { actorOf } from '../../utils/resources/caller'

// Booked slots of the resources the caller may read; details only where the caller may see them.
export default defineApiHandler(async (event, { db, user }) => {
  const query = expectValid(parseAvailabilityQuery(getQuery(event)))
  return listAvailability(db, await actorOf(event, user), query)
})
