import { defineApiHandler } from '../../utils/api/handler'
import { actorOf } from '../../utils/resources/caller'
import { listBookingRequests } from '../../utils/resources/requests'

// The manager queue; empty unless the caller manages a resource.
export default defineApiHandler(async (event, { db, user }) =>
  listBookingRequests(db, await actorOf(event, user)),
)
