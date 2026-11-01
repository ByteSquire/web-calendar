import { getRouterParam } from 'h3'
import { getResource } from '../../../../db/resources'
import { listResourceAcl } from '../../../../db/resource-acl'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { found } from '../../../../utils/api/errors'
import { parseId } from '../../../../utils/api/validation'
import { aclDto } from '../../../../utils/resources/dto'

export default defineAdminHandler((event, { db }) => {
  const id = parseId(getRouterParam(event, 'id'))
  found(getResource(db, id))
  return { rules: listResourceAcl(db, id).map(aclDto) }
})
