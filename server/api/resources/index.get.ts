import { defineApiHandler } from '../../utils/api/handler'
import { resourceDto } from '../../utils/resources/dto'
import { actorOf } from '../../utils/resources/caller'
import { listResourcesFor } from '../../utils/resources/service'

// The active resources the caller may at least read, with their own right on each.
export default defineApiHandler(async (event, { db, user }) => {
  const actor = await actorOf(event, user)
  return {
    resources: listResourcesFor(db, actor).map(({ resource, right }) =>
      resourceDto(resource, right),
    ),
  }
})
