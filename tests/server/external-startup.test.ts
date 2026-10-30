// @vitest-environment node
// The startup checks of the external accounts against the REAL glue modules with a runtime config
// like the one Nitro would give them: a malformed NUXT_EXTERNAL_SEAL_KEY or NUXT_OUTBOUND_ALLOWED_HOSTS
// stops the server at start with a readable message, instead of a 500 on the first request.
import { afterEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ current: {} as unknown }))

vi.mock('#app/nuxt', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRuntimeConfig: () => config.current,
}))

interface TestConfig {
  radicale: { url: string }
  icalProxy: Record<string, unknown>
  outbound: { allowedHosts: string }
  external: { sealKey: string }
}

const GOOD_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')

function goodConfig(): TestConfig {
  return {
    radicale: { url: 'http://radicale:5232' },
    icalProxy: {
      cacheTtlSec: '300',
      maxBytes: '5242880',
      timeoutMs: '10000',
      allowPrivate: 'false',
    },
    outbound: { allowedHosts: '' },
    external: { sealKey: GOOD_KEY },
  }
}

/** Fresh glue modules (they cache what they parse) and what the startup checks make of them. */
async function startWith(mutate: (c: TestConfig) => void = () => {}) {
  vi.restoreAllMocks()
  const fresh = goodConfig()
  config.current = fresh
  mutate(fresh)
  vi.resetModules()
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { installExternalStartupChecks } = await import('../../server/utils/external/startup')
  const hooks: Record<string, () => Promise<void>> = {}
  installExternalStartupChecks({ hook: (name, fn) => void (hooks[name] = fn) })
  await hooks.request!()
  return {
    exited: exit.mock.calls.length > 0,
    message: String(error.mock.calls[0]?.[0] ?? ''),
    info: info.mock.calls.map((call) => String(call[0])),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startup checks of the external accounts', () => {
  it('pass for a good configuration', async () => {
    expect(await startWith()).toMatchObject({ exited: false, message: '' })
  })

  it('pass without a seal key and say that logins are off', async () => {
    const result = await startWith((c) => (c.external.sealKey = ''))
    expect(result).toMatchObject({ exited: false, message: '' })
    expect(result.info.join('\n')).toContain('external accounts with a login are off')
    expect((await startWith((c) => (c.external.sealKey = '   '))).exited).toBe(false)
  })

  it('pass with a host list', async () => {
    const result = await startWith(
      (c) => (c.outbound.allowedHosts = 'cal.example.org, *.corp.example'),
    )
    expect(result.exited).toBe(false)
    expect(result.info.join('\n')).toContain('2 listed host entries')
  })

  it.each(['secret', 'ab'.repeat(31), '00'.repeat(32), 'not base64 !!!'])(
    'stop the server for the seal key %j, and the message does not print the key',
    async (key) => {
      const result = await startWith((c) => (c.external.sealKey = key))
      expect(result.exited).toBe(true)
      expect(result.message).toContain('NUXT_EXTERNAL_SEAL_KEY must be')
      expect(result.message).not.toContain(key)
    },
  )

  it.each(['*', 'https://cal.example.org', 'cal.example.org:443', 'a,,b'])(
    'stop the server for the host list %j',
    async (list) => {
      const result = await startWith((c) => (c.outbound.allowedHosts = list))
      expect(result.exited).toBe(true)
      expect(result.message).toContain('NUXT_OUTBOUND_ALLOWED_HOSTS')
    },
  )

  it('report both when both are wrong', async () => {
    const result = await startWith((c) => {
      c.external.sealKey = 'secret'
      c.outbound.allowedHosts = '*'
    })
    expect(result.message).toContain('NUXT_OUTBOUND_ALLOWED_HOSTS')
    expect(result.message).toContain('NUXT_EXTERNAL_SEAL_KEY')
  })

  it('build the policy with the store’s host refused and the list in force', async () => {
    await startWith((c) => {
      c.outbound.allowedHosts = 'radicale, cal.example.org'
      c.icalProxy.allowPrivate = 'false'
    })
    const { getIcalPolicy, privateAddressesAllowed } =
      await import('../../server/utils/ical-proxy/nitro')
    const policy = getIcalPolicy()
    expect(privateAddressesAllowed()).toBe(false)
    expect(policy.isUnlistedHostname?.('example.net')).toBe(true)
    expect(policy.isUnlistedHostname?.('cal.example.org')).toBe(false)
    // Listed, and still refused: it is the host of NUXT_RADICALE_URL.
    expect(policy.isUnlistedHostname?.('radicale')).toBe(false)
    expect(policy.isBlockedHostname('radicale')).toBe(true)
  })
})
