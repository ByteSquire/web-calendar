import { readBody, setResponseStatus } from 'h3'
import { createResource } from '../../../db/resources'
import { notifyAclChanged } from '../../../utils/access/ports'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { expectValid } from '../../../utils/api/validation'
import { resourceDto } from '../../../utils/resources/dto'
import { parseResourceCreate } from '../../../utils/resources/input'

export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const fields = expectValid(parseResourceCreate(await readBody(event)))
  const resource = atomic(() => {
    const created = createResource(db, fields)
    audit('resource.created', `resource:${created.id}`, { resourceId: created.id })
    return created
  })
  // Its calendar is made, and shared by its first rules.
  notifyAclChanged()
  setResponseStatus(event, 201)
  return resourceDto(resource)
})
