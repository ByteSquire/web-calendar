import { getRouterParam } from 'h3'
import { deactivateResource } from '../../../../db/resources'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { found } from '../../../../utils/api/errors'
import { parseId } from '../../../../utils/api/validation'
import { resourceDto } from '../../../../utils/resources/dto'

// New bookings stop; existing ones and their blocks stay (the resource is not deleted).
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  return atomic(() => {
    const resource = found(deactivateResource(db, id))
    audit('resource.deactivated', `resource:${id}`, { resourceId: id })
    return resourceDto(resource)
  })
})
