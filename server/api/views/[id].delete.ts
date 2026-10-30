import { getRouterParam, setResponseStatus } from 'h3'
import { deleteView } from '../../db/views'
import { notFound } from '../../utils/api/errors'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'

export default defineApiHandler((event, { db, user }) => {
  if (!deleteView(db, user.id, parseId(getRouterParam(event, 'id')))) throw notFound()
  setResponseStatus(event, 204)
  return null
})
