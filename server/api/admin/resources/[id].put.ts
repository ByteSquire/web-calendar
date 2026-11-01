import { getRouterParam, readBody } from 'h3'
import { updateResource } from '../../../db/resources'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { expectValid, parseId } from '../../../utils/api/validation'
import { resourceDto } from '../../../utils/resources/dto'
import { parseResourceUpdate } from '../../../utils/resources/input'

export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const patch = expectValid(parseResourceUpdate(await readBody(event)))
  return atomic(() => {
    const resource = found(updateResource(db, id, patch))
    audit('resource.updated', `resource:${id}`, {
      resourceId: id,
      fields: Object.keys(patch).sort(),
    })
    return resourceDto(resource)
  })
})
