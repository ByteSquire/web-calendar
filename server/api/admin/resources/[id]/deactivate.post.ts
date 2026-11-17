import { getRouterParam } from 'h3'
import { deactivateResource } from '../../../../db/resources'
import { notifyAclChanged } from '../../../../utils/access/ports'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { found } from '../../../../utils/api/errors'
import { parseId } from '../../../../utils/api/validation'
import { resourceDto } from '../../../../utils/resources/dto'

// New bookings stop; existing ones and their blocks stay (the resource is not deleted). Its calendar
// leaves the calendar apps: the reconcile, asked for here, removes its shares (design §5).
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const saved = atomic(() => {
    const resource = found(deactivateResource(db, id))
    audit('resource.deactivated', `resource:${id}`, { resourceId: id })
    return resourceDto(resource)
  })
  notifyAclChanged()
  return saved
})
