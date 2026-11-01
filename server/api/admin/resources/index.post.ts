import { readBody, setResponseStatus } from 'h3'
import { createResource } from '../../../db/resources'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { expectValid } from '../../../utils/api/validation'
import { resourceDto } from '../../../utils/resources/dto'
import { parseResourceCreate } from '../../../utils/resources/input'

export default defineAdminHandler(async (event, { db, audit }) => {
  const fields = expectValid(parseResourceCreate(await readBody(event)))
  const resource = createResource(db, fields)
  audit('resource.created', `resource:${resource.id}`, { resourceId: resource.id })
  setResponseStatus(event, 201)
  return resourceDto(resource)
})
