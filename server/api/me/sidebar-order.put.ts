import { readBody } from 'h3'
import { setUserSidebarOrder } from '../../db/users'
import { defineApiHandler } from '../../utils/api/handler'
import { parseSidebarOrderInput } from '../../utils/api/sidebar-order'
import { expectValid } from '../../utils/api/validation'

// Sets the order the caller keeps the sidebar's sections in (FR-21). The answer is the stored
// order, complete: sections the request left out follow in their default order.
export default defineApiHandler(async (event, { db, user }) => {
  const { order } = expectValid(parseSidebarOrderInput(await readBody(event)))
  return { order: setUserSidebarOrder(db, user.id, order) }
})
