// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ALLOW_PRIVATE_ACK_VARIABLE,
  parseIcalProxyConfig,
} from '../../server/utils/ical-proxy/config'

const defaults = {
  cacheTtlSec: '300',
  maxBytes: '5242880',
  timeoutMs: '10000',
  allowPrivate: 'false',
}

describe('parseIcalProxyConfig', () => {
  it('reads the defaults of nuxt.config.ts', () => {
    expect(parseIcalProxyConfig(defaults)).toEqual({
      cacheTtlSec: 300,
      maxBytes: 5242880,
      timeoutMs: 10000,
      allowPrivate: false,
    })
  })

  it('takes numbers and booleans, which is what Nuxt may hand over after parsing an env value', () => {
    expect(
      parseIcalProxyConfig({ cacheTtlSec: 60, maxBytes: 1024, timeoutMs: 500, allowPrivate: true }),
    ).toEqual({ cacheTtlSec: 60, maxBytes: 1024, timeoutMs: 500, allowPrivate: true })
    expect(parseIcalProxyConfig({ ...defaults, allowPrivate: 'true' }).allowPrivate).toBe(true)
  })

  it('allows a TTL of 0 (always ask the source)', () => {
    expect(parseIcalProxyConfig({ ...defaults, cacheTtlSec: '0' }).cacheTtlSec).toBe(0)
  })

  it.each(['false', '', 'yes', '1', 'TRUE ', 0, false, undefined, null])(
    'keeps the guard on for allowPrivate=%j',
    (value) => {
      expect(parseIcalProxyConfig({ ...defaults, allowPrivate: value }).allowPrivate).toBe(false)
    },
  )

  it.each([
    ['cacheTtlSec', '-1', 'NUXT_ICAL_PROXY_CACHE_TTL_SEC'],
    ['cacheTtlSec', 'soon', 'NUXT_ICAL_PROXY_CACHE_TTL_SEC'],
    ['maxBytes', '0', 'NUXT_ICAL_PROXY_MAX_BYTES'],
    ['maxBytes', '5.5', 'NUXT_ICAL_PROXY_MAX_BYTES'],
    ['maxBytes', '', 'NUXT_ICAL_PROXY_MAX_BYTES'],
    ['timeoutMs', '0', 'NUXT_ICAL_PROXY_TIMEOUT_MS'],
    ['timeoutMs', 'NaN', 'NUXT_ICAL_PROXY_TIMEOUT_MS'],
  ])('rejects %s=%j and names the variable', (key, value, variable) => {
    expect(() => parseIcalProxyConfig({ ...defaults, [key]: value })).toThrow(variable)
  })
})

describe('allowPrivate in production (L3)', () => {
  const production = { production: true, allowPrivateAcknowledged: false }
  const acknowledged = { production: true, allowPrivateAcknowledged: true }

  it('is refused: the server must not start with the SSRF guard off', () => {
    for (const allowPrivate of ['true', true]) {
      expect(() => parseIcalProxyConfig({ ...defaults, allowPrivate }, production)).toThrow(
        /NUXT_ICAL_PROXY_ALLOW_PRIVATE=true.*refused when NODE_ENV=production/s,
      )
    }
  })

  it('names the second switch in the error, so the operator who really needs it can find it', () => {
    expect(ALLOW_PRIVATE_ACK_VARIABLE).toBe('NUXT_ICAL_PROXY_ALLOW_PRIVATE_I_UNDERSTAND_THE_RISK')
    expect(() => parseIcalProxyConfig({ ...defaults, allowPrivate: 'true' }, production)).toThrow(
      ALLOW_PRIVATE_ACK_VARIABLE,
    )
  })

  it('is honoured with the second switch', () => {
    expect(
      parseIcalProxyConfig({ ...defaults, allowPrivate: 'true' }, acknowledged).allowPrivate,
    ).toBe(true)
  })

  it('does not matter when the guard stays on, with or without the switch', () => {
    for (const environment of [production, acknowledged]) {
      expect(parseIcalProxyConfig(defaults, environment).allowPrivate).toBe(false)
      expect(
        parseIcalProxyConfig({ ...defaults, allowPrivate: 'TRUE' }, environment).allowPrivate,
      ).toBe(false)
    }
  })

  it('is allowed outside production, which is where tests and development run', () => {
    const development = { production: false, allowPrivateAcknowledged: false }
    expect(
      parseIcalProxyConfig({ ...defaults, allowPrivate: 'true' }, development).allowPrivate,
    ).toBe(true)
    expect(parseIcalProxyConfig({ ...defaults, allowPrivate: 'true' }).allowPrivate).toBe(true)
  })
})
