import { getRouterParam } from 'h3'
import { found } from '../../utils/api/errors'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'
import { actorOf } from '../../utils/resources/caller'
import { resourceDto } from '../../utils/resources/dto'
import { getResourceFor } from '../../utils/resources/service'

export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const { resource, right } = found(getResourceFor(db, await actorOf(event, user), id))
  return resourceDto(resource, right)
})
