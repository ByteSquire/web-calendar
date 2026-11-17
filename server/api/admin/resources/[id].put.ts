import { getRouterParam, readBody } from 'h3'
import { updateResource } from '../../../db/resources'
import { notifyAclChanged } from '../../../utils/access/ports'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { expectValid, parseId } from '../../../utils/api/validation'
import { resourceDto } from '../../../utils/resources/dto'
import { parseResourceUpdate } from '../../../utils/resources/input'

export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const patch = expectValid(parseResourceUpdate(await readBody(event)))
  const saved = atomic(() => {
    const resource = found(updateResource(db, id, patch))
    audit('resource.updated', `resource:${id}`, {
      resourceId: id,
      fields: Object.keys(patch).sort(),
    })
    return resourceDto(resource)
  })
  // Its calendar follows a new name, and a deactivated or reactivated resource loses or gets back
  // its shares (design §5).
  notifyAclChanged()
  return saved
})
