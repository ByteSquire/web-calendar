import { listIcalSubscriptions } from '../../db/ical-subscriptions'
import { defineApiHandler } from '../../utils/api/handler'

// The user's own iCal subscriptions and the shared ones (FR-7).
export default defineApiHandler((_event, { db, user }) => ({
  subscriptions: listIcalSubscriptions(db, user.id),
}))
