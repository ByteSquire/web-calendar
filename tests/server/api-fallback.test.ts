// @vitest-environment node
// L4: no `/api/**` URL answers with the SPA shell. The real route files are listed from
// server/api and mapped to routes the way Nitro does (`[id]` -> `:id`, `[...x]` -> `**`, `index`
// dropped, `.get` and so on -> method), then put into an h3 router built like Nitro's
// (`preemptive`, the page renderer as `/**`, the real middleware and the real `render:before`
// hook in front). Handlers are stubs: what is tested is what answers when a route does not.
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  setResponseHeader,
  toWebHandler,
  type RouterMethod,
} from 'h3'
import { describe, expect, it } from 'vitest'
import { createTestHooks } from './api-fixtures'
import apiGuards from '../../server/middleware/api-guards'
import {
  apiNotFoundResponse,
  installApiFallback,
  isApiPath,
  isNonCanonicalApiPath,
  requestPathname,
  type RenderBeforeContext,
} from '../../server/utils/api/not-found'

const API_DIR = fileURLToPath(new URL('../../server/api', import.meta.url))
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const SHELL = '<!doctype html><title>app shell</title>'

interface RouteFile {
  file: string
  /** h3 router path, e.g. `/api/views/:id`. */
  route: string
  /** Lower case, or undefined for a handler of every method. */
  method?: RouterMethod
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/** Nitro's file-based routing for `server/api`, as far as this project uses it. */
function routeFiles(): RouteFile[] {
  return listFiles(API_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => {
      const parts = relative(API_DIR, file).replace(/\.ts$/, '').split('/')
      const last = /^(.*?)(?:\.(get|post|put|patch|delete|head|options))?$/.exec(parts.pop()!)!
      const segments = [...parts, last[1]!]
        .filter((segment) => segment !== 'index')
        .map((segment) =>
          segment.replace(/^\[\.\.\.(\w+)\]$/, '**:$1').replace(/^\[(.+)\]$/, ':$1'),
        )
      return {
        file,
        route: `/api/${segments.join('/')}`.replace(/\/$/, ''),
        method: last[2] as RouterMethod | undefined,
      }
    })
}

function buildApp(options: { fallback: boolean }) {
  const hooks = createTestHooks<{ 'render:before': (context: RenderBeforeContext) => void }>()
  if (options.fallback) installApiFallback(hooks)

  // The renderer of Nitro (`defineRenderHandler`): hook, then the shell unless a hook answered.
  const renderer = defineEventHandler(async (event) => {
    const context: RenderBeforeContext & {
      response?: { statusCode: number; headers: Record<string, string>; body: string }
    } = { event }
    await hooks.callHook('render:before', context)
    if (context.response) {
      event.node.res.statusCode = context.response.statusCode
      for (const [name, value] of Object.entries(context.response.headers)) {
        setResponseHeader(event, name, value)
      }
      return context.response.body
    }
    setResponseHeader(event, 'content-type', 'text/html;charset=utf-8')
    return SHELL
  })

  const router = createRouter({ preemptive: true })
  for (const { route, method } of routeFiles()) {
    // `server/api/[...path].ts` throws a 404; the others would do their work.
    const stub = defineEventHandler(() => {
      if (route.includes('**')) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
      return { ok: true, route }
    })
    router.use(route, stub, method)
  }
  router.use('/**', renderer)

  const app = createApp()
  app.use(apiGuards)
  app.use(router.handler)
  const handle = toWebHandler(app)

  return async (method: string, path: string, token?: string) => {
    const headers = new Headers(token ? { authorization: `Bearer ${token}` } : {})
    const response = await handle(new Request(`http://localhost${path}`, { method, headers }))
    return { status: response.status, type: response.headers.get('content-type') ?? '', response }
  }
}

const withFallback = buildApp({ fallback: true })
const files = routeFiles()
const concrete = (route: string) => route.replace(/\*\*:\w+/, 'anything').replace(/:\w+/g, '1')

describe('the route files', () => {
  it('are found and mapped (the walk below depends on it)', () => {
    const routes = files.map((f) => `${f.method ?? 'all'} ${f.route}`)
    expect(routes).toEqual(
      expect.arrayContaining([
        'get /api/me',
        'put /api/views/:id',
        'delete /api/calendar-prefs',
        'get /api/ical-subscriptions/:id/data',
        'all /api/**:path',
      ]),
    )
    expect(files.length).toBeGreaterThan(20)
  })
})

describe('/api/** never answers with the SPA shell', () => {
  it('(control) the router alone would: an unsupported method falls through to the renderer', async () => {
    const without = buildApp({ fallback: false })
    const reply = await without('PUT', '/api/me', 'token')
    expect(reply.status).toBe(200)
    expect(reply.type).toContain('text/html')
    expect((await without('GET', '/api')).type).toContain('text/html')
  })

  async function expectJson404(method: string, path: string, token?: string) {
    const reply = await withFallback(method, path, token)
    const label = `${method} ${path}${token ? ' (with token)' : ''}`
    expect([label, reply.status]).toEqual([label, 404])
    expect([label, reply.type]).toEqual([label, expect.stringContaining('application/json')])
    if (method !== 'HEAD') {
      const body = (await reply.response.text()) as string
      expect([label, body]).not.toEqual([label, expect.stringContaining('app shell')])
      expect(JSON.parse(body)).toMatchObject({ statusCode: 404 })
    }
  }

  it.each(files.filter((f) => f.method))(
    '$method $route: the supported method answers, its trailing-slash spelling is a 404',
    async ({ route, method }) => {
      const path = concrete(route)
      for (const token of [undefined, 'token']) {
        const reply = await withFallback(method!.toUpperCase(), path, token)
        expect(reply.status).toBe(200)
        expect(reply.type).toContain('application/json')
        await expectJson404(method!.toUpperCase(), `${path}/`, token)
        await expectJson404(method!.toUpperCase(), `${path}/?x=1`, token)
      }
    },
  )

  it('answers 404 JSON for every method a route does not implement, with and without a token', async () => {
    const methodsOf = new Map<string, Set<string>>()
    for (const { route, method } of files) {
      if (route.includes('**')) continue
      methodsOf.set(route, (methodsOf.get(route) ?? new Set()).add((method ?? 'all').toUpperCase()))
    }
    expect(methodsOf.size).toBeGreaterThan(10)
    for (const [route, supported] of methodsOf) {
      if (supported.has('ALL')) continue
      for (const method of METHODS.filter((m) => !supported.has(m))) {
        for (const token of [undefined, 'token']) {
          await expectJson404(method, concrete(route), token)
        }
      }
    }
  })

  it.each([
    '/api',
    '/api/',
    '/api/nope',
    '/api/nope/deeper/still',
    '/api//views',
    '/api/views//',
    '/api/views/1/extra',
    '/api/me/extra',
    '/api/ME',
  ])('%s is a JSON 404 for every method', async (path) => {
    for (const method of METHODS) {
      for (const token of [undefined, 'token']) await expectJson404(method, path, token)
    }
  })

  it('leaves the rest of the site to the renderer', async () => {
    for (const path of ['/', '/settings', '/auth/callback', '/apix', '/api-docs', '/x/api/y']) {
      const reply = await withFallback('GET', path)
      expect([path, reply.status, reply.type]).toEqual([
        path,
        200,
        expect.stringContaining('text/html'),
      ])
    }
  })

  it('does not echo the query string', async () => {
    const reply = await withFallback('PUT', '/api/me?secret=abc')
    expect(await reply.response.text()).not.toContain('secret')
  })

  it('hardens the 404 like Nitro’s own error answers', async () => {
    const reply = await withFallback('PUT', '/api/me')
    expect(reply.response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(reply.response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('helpers', () => {
  it.each([
    ['/api/me', '/api/me'],
    ['/api/me?x=1', '/api/me'],
    ['/api/views/?a=/b', '/api/views/'],
    ['/api/x#frag', '/api/x'],
    ['/', '/'],
  ])('requestPathname(%j) = %j', (path, expected) => {
    expect(requestPathname(path)).toBe(expected)
  })

  it.each([
    ['/api', true],
    ['/api/', true],
    ['/api/me', true],
    ['/api?x=1', true],
    ['/api-docs', false],
    ['/apix/me', false],
    ['/', false],
    ['/x/api/me', false],
    ['/API/me', false],
  ])('isApiPath(%j) = %s', (path, expected) => {
    expect(isApiPath(path)).toBe(expected)
  })

  it.each([
    ['/api/me', false],
    ['/api/views/1', false],
    ['/api/me?next=/a/', false],
    ['/api/', true],
    ['/api/me/', true],
    ['/api/me/?x=1', true],
    ['/api//me', true],
    ['/api/a//', true],
  ])('isNonCanonicalApiPath(%j) = %s', (path, expected) => {
    expect(isNonCanonicalApiPath(path)).toBe(expected)
  })

  it('apiNotFoundResponse is a 404 JSON document', () => {
    const response = apiNotFoundResponse('/api/x?y=1')
    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body)).toEqual({
      error: true,
      url: '/api/x',
      statusCode: 404,
      statusMessage: 'Not Found',
      message: 'Not Found',
    })
  })

  it('the hook leaves a request outside /api alone', async () => {
    const hooks = createTestHooks<{ 'render:before': (context: RenderBeforeContext) => void }>()
    installApiFallback(hooks)
    const context: RenderBeforeContext = { event: { path: '/settings' } }
    await hooks.callHook('render:before', context)
    expect(context.response).toBeUndefined()
  })
})
