import { getRouterParam } from 'h3'
import { countResourceBookings, deleteResourceRow, getResource } from '../../../db/resources'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { conflict, found } from '../../../utils/api/errors'
import { parseId } from '../../../utils/api/validation'

// Deletes a resource with its rules (admins only). A resource with bookings, past ones and cancelled
// ones included, is kept: the bookings and their blocks name it. Deactivating stops new bookings.
// A resource has nothing of its own in Radicale; its blocks belong to its bookings.
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  atomic(() => {
    const resource = found(getResource(db, id))
    if (countResourceBookings(db, id) > 0) {
      throw conflict('has_bookings', 'The resource has bookings; deactivate it instead')
    }
    deleteResourceRow(db, id)
    audit('resource.deleted', `resource:${id}`, { resourceId: id, name: resource.name })
  })
  return {}
})
