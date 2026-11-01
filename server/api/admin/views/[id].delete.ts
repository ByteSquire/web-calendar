import { getRouterParam, setResponseStatus } from 'h3'
import { deleteAdminView } from '../../../db/views'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { parseId } from '../../../utils/api/validation'

// Deletes a shared view; a user's view is 404 here.
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  atomic(() => {
    const view = found(deleteAdminView(db, id))
    audit('admin_view.deleted', String(view.id), { name: view.name })
  })
  setResponseStatus(event, 204)
  return null
})
