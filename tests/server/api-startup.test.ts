// @vitest-environment node
import { getRequestIP } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '../../server/utils/auth/errors'
import { installStartupChecks } from '../../server/utils/api/startup'
import { createSelfTestEvent, runStartupChecks } from '../../server/utils/api/startup-checks'

const gateway = vi.hoisted(() => ({ handle: vi.fn() }))
const auth = vi.hoisted(() => ({ authenticate: vi.fn() }))
const ical = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('../../server/utils/auth/nitro', () => ({ authenticateCalDav: auth.authenticate }))
vi.mock('../../server/utils/gateway/nitro', () => ({ handleGatewayRequest: gateway.handle }))
vi.mock('../../server/utils/ical-proxy/nitro', () => ({ getIcalProxy: ical.get }))

describe('runStartupChecks', () => {
  it('passes when every check does', async () => {
    const ran: string[] = []
    const failures = await runStartupChecks([
      { name: 'a', run: () => void ran.push('a') },
      { name: 'b', run: async () => void ran.push('b') },
    ])
    expect(failures).toEqual([])
    expect(ran).toEqual(['a', 'b'])
  })

  it('reports every failure, named, and runs the checks after a failed one', async () => {
    const failures = await runStartupChecks([
      {
        name: 'first',
        run: () => {
          throw new Error('NUXT_OIDC_KEY_MAX_AGE_SEC must be a positive integer, got "x"')
        },
      },
      { name: 'fine', run: () => undefined },
      { name: 'second', run: async () => Promise.reject(new Error('rejected')) },
      {
        name: 'third',
        run: () => {
          throw 'plain text'
        },
      },
    ])
    expect(failures).toEqual([
      'first: NUXT_OIDC_KEY_MAX_AGE_SEC must be a positive integer, got "x"',
      'second: rejected',
      'third: plain text',
    ])
  })
})

describe('createSelfTestEvent', () => {
  it('is a request the gateway glue can read, without a client address', () => {
    const event = createSelfTestEvent('GET', '/caldav/')
    expect(event.method).toBe('GET')
    expect(event.path).toBe('/caldav/')
    expect(event.node.req.headers).toEqual({})
    expect([...event.headers]).toEqual([])
    expect(getRequestIP(event)).toBeUndefined()
    expect(typeof event.node.res.once).toBe('function')
  })
})

describe('the startup checks (L2, server/plugins/startup.ts)', () => {
  let hooks: Record<string, () => Promise<void>>
  let exit: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  let demo: unknown

  /** Installs the checks and returns once the promise requests wait for is settled. */
  async function start() {
    hooks = {}
    installStartupChecks({ hook: (name, fn) => void (hooks[name] = fn) }, { demo })
    await hooks.request?.()
  }

  beforeEach(() => {
    demo = false
    auth.authenticate.mockImplementation(() => Promise.reject(new AuthError('no-credentials')))
    gateway.handle.mockResolvedValue(new Response('', { status: 401 }))
    ical.get.mockReturnValue({})
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('lets a good configuration start and holds requests until the checks are done', async () => {
    await start()
    expect(exit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(hooks.request).toBeTypeOf('function')
    expect(auth.authenticate).toHaveBeenCalledTimes(1)
    expect(gateway.handle).toHaveBeenCalledTimes(1)
    expect(ical.get).toHaveBeenCalledTimes(1)
    const event = gateway.handle.mock.calls[0]![0]
    expect([event.method, event.path]).toEqual(['GET', '/caldav/'])
  })

  it('exits with a readable message when the verifier configuration is wrong', async () => {
    auth.authenticate.mockImplementation(() => {
      throw new Error('NUXT_OIDC_KEY_MAX_AGE_SEC must be a positive integer, got "undefined"')
    })
    await start()
    expect(exit).toHaveBeenCalledWith(1)
    const message = String(error.mock.calls[0]![0])
    expect(message).toContain('cannot start')
    expect(message).toContain('OIDC token verifier')
    expect(message).toContain('NUXT_OIDC_KEY_MAX_AGE_SEC must be a positive integer')
  })

  it('exits when the gateway configuration is wrong', async () => {
    gateway.handle.mockImplementation(() => {
      throw new Error('NUXT_GATEWAY_MAX_BODY_BYTES must be a positive integer, got "lots"')
    })
    await start()
    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]![0])).toContain('NUXT_GATEWAY_MAX_BODY_BYTES')
  })

  it('exits when the iCal proxy configuration is wrong, including allowPrivate in production', async () => {
    ical.get.mockImplementation(() => {
      throw new Error('NUXT_ICAL_PROXY_ALLOW_PRIVATE=true turns off the SSRF guard')
    })
    await start()
    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]![0])).toContain('SSRF guard')
  })

  it('lists every failed part, not only the first', async () => {
    auth.authenticate.mockImplementation(() => {
      throw new Error('verifier broken')
    })
    ical.get.mockImplementation(() => {
      throw new Error('proxy broken')
    })
    await start()
    const message = String(error.mock.calls[0]![0])
    expect(message).toContain('verifier broken')
    expect(message).toContain('proxy broken')
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['accepts a request without credentials', () => Promise.resolve({ sub: 'x', via: 'bearer' })],
    ['rejects it for another reason', () => Promise.reject(new AuthError('malformed'))],
  ])('exits when the verifier %s', async (_label, answer) => {
    auth.authenticate.mockImplementation(answer)
    await start()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it.each([200, 500, 502, 429])('exits when the gateway answers %i, not 401', async (status) => {
    gateway.handle.mockResolvedValue(new Response('', { status }))
    await start()
    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]![0])).toContain(`answered ${status}`)
  })

  it.each([[true], ['true']])('warns loudly about demo mode (%j)', async (value) => {
    demo = value
    await start()
    expect(String(warn.mock.calls[0]![0])).toContain('DEMO MODE')
    expect(exit).not.toHaveBeenCalled()
  })

  it.each([[false], ['false'], [undefined]])(
    'says nothing about demo mode when it is %j',
    async (value) => {
      demo = value
      await start()
      expect(warn).not.toHaveBeenCalled()
    },
  )
})
