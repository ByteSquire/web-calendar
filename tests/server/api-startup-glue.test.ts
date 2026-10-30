// @vitest-environment node
// The startup checks against the REAL glue modules (auth, gateway, iCal proxy) with a runtime
// config like the one Nitro would give them: what the plugin does at startup, minus the process.
import { afterEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ current: {} as unknown }))

// The glue files use Nitro's auto-imported `useRuntimeConfig`; under Vitest Nuxt's transform
// resolves that name to the Vue app's composable, so this stands in for it.
vi.mock('#app/nuxt', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRuntimeConfig: () => config.current,
}))

interface TestConfig {
  oidc: Record<string, unknown>
  demo: boolean
  tokenHashKey: string
  tokenHashKeys?: string
  radicale: { url: string }
  icalProxy: Record<string, unknown>
  gateway: Record<string, unknown>
}

function goodConfig(): TestConfig {
  return {
    oidc: {
      issuer: 'https://idm.example.org/oauth2/openid/web-calendar',
      clientId: 'web-calendar',
      allowedClients: '',
      scope: 'openid',
      requiredScope: 'caldav',
      adminGroup: 'calendar_admins',
      keyMaxAgeSec: '3600',
    },
    demo: false,
    tokenHashKey: 'k'.repeat(32),
    radicale: { url: 'http://radicale:5232' },
    icalProxy: {
      cacheTtlSec: '300',
      maxBytes: '5242880',
      timeoutMs: '10000',
      allowPrivate: 'false',
    },
    gateway: { corsOrigins: '', maxBodyBytes: '10485760', trustForwardedFor: 'false' },
  }
}

/** Fresh glue modules (they cache what they parse) and the failures the startup checks report. */
async function failuresFor(mutate: (c: TestConfig) => void = () => {}) {
  vi.restoreAllMocks()
  const fresh = goodConfig()
  config.current = fresh
  mutate(fresh)
  vi.resetModules()
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { installStartupChecks } = await import('../../server/utils/api/startup')
  const hooks: Record<string, () => Promise<void>> = {}
  installStartupChecks({ hook: (name, fn) => void (hooks[name] = fn) }, { demo: false })
  await hooks.request!()
  return { exited: exit.mock.calls.length > 0, message: String(error.mock.calls[0]?.[0] ?? '') }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('startup checks with the real glue modules', () => {
  it('pass for a good configuration: the verifier, the gateway and the proxy are built', async () => {
    expect(await failuresFor()).toEqual({ exited: false, message: '' })
  })

  it.each([
    [
      'NUXT_OIDC_KEY_MAX_AGE_SEC',
      (c: TestConfig) => (c.oidc.keyMaxAgeSec = undefined),
      'positive integer',
    ],
    [
      'NUXT_OIDC_KEY_MAX_AGE_SEC',
      (c: TestConfig) => (c.oidc.keyMaxAgeSec = '0'),
      'positive integer',
    ],
    [
      'NUXT_OIDC_KEY_MAX_AGE_SEC',
      (c: TestConfig) => (c.oidc.keyMaxAgeSec = 'soon'),
      'positive integer',
    ],
    ['NUXT_OIDC_ISSUER', (c: TestConfig) => (c.oidc.issuer = ''), 'NUXT_OIDC_ISSUER is not set'],
    [
      'NUXT_GATEWAY_MAX_BODY_BYTES',
      (c: TestConfig) => (c.gateway.maxBodyBytes = 'lots'),
      'positive integer',
    ],
    [
      'NUXT_GATEWAY_MAX_BODY_BYTES',
      (c: TestConfig) => (c.gateway.maxBodyBytes = '-5'),
      'positive integer',
    ],
    [
      'NUXT_TOKEN_HASH_KEY',
      (c: TestConfig) => (c.tokenHashKey = ''),
      'NUXT_TOKEN_HASH_KEY is not set',
    ],
    [
      'NUXT_TOKEN_HASH_KEYS',
      (c: TestConfig) => (c.tokenHashKeys = '2:short'),
      'at least 32 characters',
    ],
    [
      'NUXT_TOKEN_HASH_KEYS',
      (c: TestConfig) => (c.tokenHashKeys = `v2:${'n'.repeat(32)}`),
      'must look like <version>:<key>',
    ],
    [
      'NUXT_TOKEN_HASH_KEY',
      (c: TestConfig) => (c.tokenHashKeys = `1:${'n'.repeat(32)}`),
      'another key for version 1',
    ],
    [
      'NUXT_ICAL_PROXY_MAX_BYTES',
      (c: TestConfig) => (c.icalProxy.maxBytes = '0'),
      'NUXT_ICAL_PROXY_MAX_BYTES',
    ],
    [
      'NUXT_ICAL_PROXY_TIMEOUT_MS',
      (c: TestConfig) => (c.icalProxy.timeoutMs = 'x'),
      'NUXT_ICAL_PROXY_TIMEOUT_MS',
    ],
  ])(
    'make the process exit, naming %s (instead of a 500 on every request)',
    async (name, mutate, hint) => {
      const result = await failuresFor(mutate)
      expect(result.exited).toBe(true)
      expect(result.message).toContain(name)
      expect(result.message).toContain(hint)
    },
  )

  it('accepts a rotated key list next to the old key, and the list alone', async () => {
    const rotated = `2:${'n'.repeat(32)}`
    expect((await failuresFor((c) => (c.tokenHashKeys = rotated))).message).not.toContain(
      'NUXT_TOKEN_HASH',
    )
    const listOnly = await failuresFor((c) => {
      c.tokenHashKey = ''
      c.tokenHashKeys = rotated
    })
    expect(listOnly.message).not.toContain('NUXT_TOKEN_HASH')
  })

  it('does not print a key when it refuses the settings', async () => {
    const secret = 'sh0rt-s3cret'
    const { message } = await failuresFor((c) => (c.tokenHashKeys = `2:${secret}`))
    expect(message).toContain('NUXT_TOKEN_HASH_KEYS')
    expect(message).not.toContain(secret)
  })

  it('fails closed on an empty required scope: no token check is built without it', async () => {
    const result = await failuresFor((c) => (c.oidc.requiredScope = ''))
    expect(result.exited).toBe(true)
    expect(result.message).toContain('requiredScope must not be empty')
  })

  it('reports each broken part once', async () => {
    const { message } = await failuresFor((c) => {
      c.oidc.keyMaxAgeSec = '0'
      c.gateway.maxBodyBytes = '0'
      c.icalProxy.maxBytes = '0'
    })
    expect(message).toContain('NUXT_OIDC_KEY_MAX_AGE_SEC')
    expect(message).toContain('NUXT_GATEWAY_MAX_BODY_BYTES')
    expect(message).toContain('NUXT_ICAL_PROXY_MAX_BYTES')
  })

  it('lets allowPrivate through outside production (these tests run with NODE_ENV=test)', async () => {
    expect((await failuresFor((c) => (c.icalProxy.allowPrivate = 'true'))).exited).toBe(false)
  })

  it('refuses allowPrivate in production without the second switch, accepts it with it', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const refused = await failuresFor((c) => (c.icalProxy.allowPrivate = 'true'))
    expect(refused.exited).toBe(true)
    expect(refused.message).toContain('SSRF guard')

    vi.stubEnv('NUXT_ICAL_PROXY_ALLOW_PRIVATE_I_UNDERSTAND_THE_RISK', 'true')
    expect((await failuresFor((c) => (c.icalProxy.allowPrivate = 'true'))).exited).toBe(false)
  })
})
