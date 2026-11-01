import { readBody, setResponseStatus } from 'h3'
import { createAdminView } from '../../../db/views'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { expectValid } from '../../../utils/api/validation'
import { parseViewInput } from '../../../utils/api/views'

// Creates a shared view. Calendars are not looked up: a ref the viewer cannot read is simply
// empty for them (Radicale answers 403), so nothing is revealed or guessed here.
export default defineAdminHandler(async (event, { db, audit }) => {
  const input = expectValid(parseViewInput(await readBody(event), { allowExternal: false }))
  const view = createAdminView(db, input)
  audit('admin_view.created', String(view.id), { name: view.name })
  setResponseStatus(event, 201)
  return view
})
