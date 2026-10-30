// @vitest-environment node
// Nitro hands `onBeforeResponse` of its h3 app to the `beforeResponse` hook; the app below is
// wired the same way (over real HTTP, as Nitro serves it), with handlers that set `X-Powered-By` the way Nuxt's renderer does.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  setResponseHeaders,
  toNodeListener,
  type H3Event,
} from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { installPoweredByRemoval } from '../../server/utils/api/powered-by'
import { createTestHooks } from './api-fixtures'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function serve(options: { strip: boolean }) {
  const hooks = createTestHooks<{ beforeResponse: (event: H3Event) => void }>()
  if (options.strip) installPoweredByRemoval(hooks)

  const app = createApp({
    onBeforeResponse: async (event) => {
      await hooks.callHook('beforeResponse', event)
    },
  })
  const router = createRouter()
  router.get(
    '/',
    defineEventHandler((event) => {
      setResponseHeaders(event, { 'content-type': 'text/html', 'x-powered-by': 'Nuxt' })
      return '<html></html>'
    }),
  )
  router.get(
    '/json',
    defineEventHandler((event) => {
      setResponseHeaders(event, { 'x-powered-by': 'Nuxt', 'cache-control': 'no-store' })
      return { ok: true }
    }),
  )
  router.get(
    '/empty',
    defineEventHandler((event) => {
      setResponseHeaders(event, { 'x-powered-by': 'Nuxt' })
      return null
    }),
  )
  router.get(
    '/fails',
    defineEventHandler((event) => {
      setResponseHeaders(event, { 'x-powered-by': 'Nuxt' })
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
    }),
  )
  app.use(router)
  const server = createServer(toNodeListener(app))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return (path: string) => fetch(`http://127.0.0.1:${port}${path}`)
}

describe('X-Powered-By', () => {
  it('(control) is sent when nothing removes it', async () => {
    const reply = await (await serve({ strip: false }))('/')
    expect(reply.headers.get('x-powered-by')).toBe('Nuxt')
  })

  it.each([
    ['a page', '/', 200],
    ['a JSON answer', '/json', 200],
    ['an empty answer', '/empty', 204],
    ['an error', '/fails', 403],
    ['an unknown path', '/nowhere', 404],
  ])('is removed from %s', async (_label, path, status) => {
    const reply = await (await serve({ strip: true }))(path)
    expect(reply.status).toBe(status)
    expect(reply.headers.get('x-powered-by')).toBeNull()
  })

  it('leaves the other headers alone', async () => {
    const reply = await (await serve({ strip: true }))('/json')
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(await reply.json()).toEqual({ ok: true })
  })
})
