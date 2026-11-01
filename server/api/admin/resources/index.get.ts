import { listResources } from '../../../db/resources'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { resourceDto } from '../../../utils/resources/dto'

export default defineAdminHandler((_event, { db }) => ({
  resources: listResources(db, { includeInactive: true }).map((resource) => resourceDto(resource)),
}))
