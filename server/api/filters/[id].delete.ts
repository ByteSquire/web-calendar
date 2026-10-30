import { getRouterParam, setResponseStatus } from 'h3'
import { deleteFilter } from '../../db/filters'
import { notFound } from '../../utils/api/errors'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'

export default defineApiHandler((event, { db, user }) => {
  if (!deleteFilter(db, user.id, parseId(getRouterParam(event, 'id')))) throw notFound()
  setResponseStatus(event, 204)
  return null
})
