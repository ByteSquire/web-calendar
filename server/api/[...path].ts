// An unknown /api path answers 404 as JSON; without this Nuxt's catch-all would return the SPA's
// index.html with status 200.
export default defineEventHandler(() => {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
})
