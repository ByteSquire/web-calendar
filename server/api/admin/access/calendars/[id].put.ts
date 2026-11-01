import { getRouterParam, readBody } from 'h3'
import { AclError, listCalendarAcl } from '../../../../db/calendar-acl'
import { accessConfig } from '../../../../utils/access/config'
import { createGroupLookup } from '../../../../utils/access/groups'
import { getAccessPorts } from '../../../../utils/access/ports'
import { checkPrincipals, parseRulesBody } from '../../../../utils/access/rules'
import { applyRules, getAccessCalendar, getCalendarRow } from '../../../../utils/access/service'
import { defineAdminHandler } from '../../../../utils/api/admin-handler'
import { ApiError, found, toBadRequest } from '../../../../utils/api/errors'
import { expectValid, parseId } from '../../../../utils/api/validation'

// Sets the complete rule list of one calendar (FR-14). Radicale follows through the port.
export default defineAdminHandler(async (event, { db, audit }) => {
  const id = parseId(getRouterParam(event, 'id'))
  found(getCalendarRow(db, id))
  const rules = expectValid(parseRulesBody(await readBody(event)))

  const kanidm = accessConfig().kanidm
  const existing = listCalendarAcl(db, id).map((row) => ({
    principalType: row.principal_type,
    principal: row.principal,
    permission: row.permission,
  }))
  const check = await checkPrincipals(
    db,
    id,
    rules,
    existing,
    kanidm ? createGroupLookup(kanidm) : null,
  )
  if (check.fields.length > 0) {
    // A group that could not be looked up is no fault of the request.
    if (check.unavailable) {
      throw new ApiError(409, check.fields[0]?.message ?? 'Kanidm is unavailable', {
        code: 'group_check_unavailable',
        fields: check.fields,
      })
    }
    throw toBadRequest(check.fields)
  }

  let outcome
  try {
    outcome = applyRules(db, id, rules)
  } catch (error) {
    if (error instanceof AclError) {
      throw toBadRequest([{ field: 'rules', message: error.message }])
    }
    throw error
  }
  if (outcome.changed) {
    audit('acl.replaced', `calendar:${id}`, outcome.details)
    try {
      getAccessPorts().onAclChanged()
    } catch (error) {
      // The rules are saved; the periodic reconcile catches up.
      console.warn(
        '[access] the reconcile request failed:',
        error instanceof Error ? error.name : error,
      )
    }
  }
  return { changed: outcome.changed, calendar: found(getAccessCalendar(db, id)) }
})
