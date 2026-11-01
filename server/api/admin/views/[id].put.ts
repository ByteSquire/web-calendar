import { getRouterParam, readBody } from 'h3'
import { updateAdminView } from '../../../db/views'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { expectValid, parseId } from '../../../utils/api/validation'
import { parseViewInput } from '../../../utils/api/views'

// Replaces a shared view; a user's view is 404 here.
export default defineAdminHandler(async (event, { db, audit }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const input = expectValid(parseViewInput(await readBody(event), { allowExternal: false }))
  const view = found(updateAdminView(db, id, input))
  audit('admin_view.updated', String(view.id), { name: view.name })
  return view
})
