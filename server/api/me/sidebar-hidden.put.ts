import { readBody } from 'h3'
import { setUserSidebarHidden } from '../../db/users'
import { defineApiHandler } from '../../utils/api/handler'
import { parseSidebarHiddenInput } from '../../utils/api/sidebar-hidden'
import { expectValid } from '../../utils/api/validation'

// Sets the items the caller has hidden from the sidebar (FR-21). The answer is the stored list.
export default defineApiHandler(async (event, { db, user }) => {
  const { hidden } = expectValid(parseSidebarHiddenInput(await readBody(event)))
  return { hidden: setUserSidebarHidden(db, user.id, hidden) }
})
