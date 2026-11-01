import { getRouterParam, readBody } from 'h3'
import { AclError } from '../../../../db/calendar-acl'
import { getResource } from '../../../../db/resources'
import { replaceResourceAcl } from '../../../../db/resource-acl'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { found, toBadRequest } from '../../../../utils/api/errors'
import { expectValid, parseId } from '../../../../utils/api/validation'
import { aclDto } from '../../../../utils/resources/dto'
import { parseResourceAcl } from '../../../../utils/resources/input'

// Replaces all rules of the resource. Only read, book and manage exist here; write-style rights
// and `public` are refused by the validation.
export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  found(getResource(db, id))
  const rules = expectValid(parseResourceAcl(await readBody(event)))
  try {
    return atomic(() => {
      const saved = replaceResourceAcl(db, id, rules)
      audit('resource.acl_replaced', `resource:${id}`, { resourceId: id, rules: saved.length })
      return { rules: saved.map(aclDto) }
    })
  } catch (error) {
    if (error instanceof AclError) throw toBadRequest([{ field: 'rules', message: error.message }])
    throw error
  }
})
