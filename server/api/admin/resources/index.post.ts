import { readBody, setResponseStatus } from 'h3'
import { createResource } from '../../../db/resources'
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
  setResponseStatus(event, 201)
  return resourceDto(resource)
})
