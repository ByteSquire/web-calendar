// @vitest-environment node
// Security headers (review M2): the pure builders, and the Nitro wiring over real HTTP the way
// Nitro serves it (`onBeforeResponse` calls the `beforeResponse` hook; the renderer calls
// `render:html` with the page it built).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createApp,
  createRouter,
  defineEventHandler,
  setResponseHeader,
  toNodeListener,
  type H3Event,
} from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDocumentCsp,
  inlineScripts,
  originOf,
  RESOURCE_CSP,
  scriptHash,
} from '../../server/utils/security/headers'
import {
  installSecurityHeaders,
  type RenderedHtml,
  type SecurityHeaderOptions,
} from '../../server/utils/security/install'
import { createTestHooks } from './api-fixtures'

describe('inlineScripts', () => {
  const page = [
    '<script type="importmap">{"imports":{"#entry":"/_nuxt/a.js"}}</script>',
    '<script type="module" src="/_nuxt/a.js" crossorigin></script>',
    '<script>"use strict";window.a=1</script>',
    '<SCRIPT TYPE=\'module\'>import "/x.js"</SCRIPT>',
    '<script type="application/json" id="__NUXT_DATA__">[1,2]</script>',
    '<script type="application/ld+json">{}</script>',
    '<script src="/other.js">ignored text</script>',
    '<script type=text/javascript>var b=2</script >',
  ].join('\n')

  it('returns the text of the inline scripts a browser would run, and nothing else', () => {
    expect(inlineScripts(page)).toEqual([
      '{"imports":{"#entry":"/_nuxt/a.js"}}',
      '"use strict";window.a=1',
      'import "/x.js"',
      'var b=2',
    ])
  })

  it('finds none in a page without inline scripts', () => {
    expect(inlineScripts('<p>script</p><script src="/a.js"></script>')).toEqual([])
  })
})

describe('scriptHash', () => {
  it('is the CSP form of a SHA-256 over the exact text', () => {
    expect(scriptHash('')).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='")
    expect(scriptHash('alert(1)')).not.toBe(scriptHash('alert(1) '))
  })
})

describe('originOf', () => {
  it('reduces an issuer URL to its origin', () => {
    expect(originOf('https://idm.example.org/oauth2/openid/web-calendar')).toBe(
      'https://idm.example.org',
    )
    expect(originOf('http://idm.localhost:8443/x')).toBe('http://idm.localhost:8443')
  })

  it('refuses anything that is not an http(s) URL', () => {
    for (const value of ['', 'idm.example.org', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(originOf(value)).toBeNull()
    }
  })
})

describe('buildDocumentCsp', () => {
  const policy = buildDocumentCsp({
    connectOrigins: ['https://idm.example.org'],
    scriptHashes: ["'sha256-AAA='", "'sha256-BBB='"],
  })
  const directive = (name: string) =>
    policy
      .split('; ')
      .find((part) => part.startsWith(`${name} `))
      ?.slice(name.length + 1)

  it('lets scripts run only from the app and from the hashed inline blocks', () => {
    expect(directive('script-src')).toBe("'self' 'sha256-AAA=' 'sha256-BBB='")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(directive('script-src')).not.toContain('unsafe-inline')
  })

  it('lets scripts talk to the app and the identity provider only', () => {
    expect(directive('connect-src')).toBe("'self' https://idm.example.org")
    expect(directive('default-src')).toBe("'self'")
  })

  it('forbids framing, plugins and a changed base URL', () => {
    expect(directive('frame-ancestors')).toBe("'none'")
    expect(directive('object-src')).toBe("'none'")
    expect(directive('base-uri')).toBe("'none'")
    expect(directive('form-action')).toBe("'self'")
  })

  it('has no identity provider origin when none is configured', () => {
    expect(buildDocumentCsp({ connectOrigins: [], scriptHashes: [] })).toContain(
      "connect-src 'self'; ",
    )
  })
})

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

const PAGE: RenderedHtml = {
  head: ['<script type="importmap">{"imports":{}}</script>'],
  bodyPrepend: [],
  body: ['<div id="__nuxt"></div>'],
  bodyAppend: ['<script>window.__NUXT__={}</script>', '<script src="/_nuxt/entry.js"></script>'],
}

async function serve(options: SecurityHeaderOptions) {
  const hooks = createTestHooks<{
    'render:html': (html: RenderedHtml, context: { event: H3Event }) => void
    beforeResponse: (event: H3Event) => void
  }>()
  installSecurityHeaders(hooks, options)

  const app = createApp({ onBeforeResponse: (event) => hooks.callHook('beforeResponse', event) })
  const router = createRouter()
  router.get(
    '/',
    defineEventHandler(async (event) => {
      setResponseHeader(event, 'content-type', 'text/html')
      await hooks.callHook('render:html', PAGE, { event })
      return '<html></html>'
    }),
  )
  router.get(
    '/json',
    defineEventHandler(() => ({ ok: true })),
  )
  router.get(
    '/ics',
    defineEventHandler((event) => {
      setResponseHeader(event, 'content-type', 'text/calendar')
      return 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'
    }),
  )
  router.get(
    '/own-policy',
    defineEventHandler((event) => {
      setResponseHeader(event, 'content-type', 'text/html')
      setResponseHeader(event, 'content-security-policy', "default-src 'none'")
      setResponseHeader(event, 'cache-control', 'max-age=60')
      return '<html></html>'
    }),
  )
  app.use(router)
  const server = createServer(toNodeListener(app))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return (path: string) => fetch(`http://127.0.0.1:${port}${path}`)
}

const production: SecurityHeaderOptions = {
  connectOrigins: ['https://idm.example.org'],
  enforcePolicy: true,
}

describe('the headers on real responses', () => {
  it('gives HTML pages a policy with the hashes of exactly their inline scripts', async () => {
    const reply = await (await serve(production))('/')
    const policy = reply.headers.get('content-security-policy') ?? ''
    expect(policy).toContain(`script-src 'self' ${scriptHash('{"imports":{}}')} `)
    expect(policy).toContain(scriptHash('window.__NUXT__={}'))
    expect(policy).toContain("connect-src 'self' https://idm.example.org")
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(reply.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  })

  it('locks down everything that is not a page', async () => {
    const get = await serve(production)
    for (const path of ['/json', '/ics']) {
      expect((await get(path)).headers.get('content-security-policy')).toBe(RESOURCE_CSP)
    }
  })

  it('sends the common headers on every answer', async () => {
    const get = await serve(production)
    for (const path of ['/', '/json', '/ics', '/missing']) {
      const reply = await get(path)
      expect(reply.headers.get('x-content-type-options')).toBe('nosniff')
      expect(reply.headers.get('referrer-policy')).toBe('no-referrer')
      expect(reply.headers.get('x-frame-options')).toBe('DENY')
      expect(reply.headers.get('permissions-policy')).toContain('camera=()')
    }
  })

  it('leaves a header the handler set itself alone', async () => {
    const reply = await (await serve(production))('/own-policy')
    expect(reply.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(reply.headers.get('cache-control')).toBe('max-age=60')
  })

  it('sends no policy in development, only the small headers', async () => {
    const reply = await (await serve({ ...production, enforcePolicy: false }))('/')
    expect(reply.headers.get('content-security-policy')).toBeNull()
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
