// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../server/validate-config.mjs'

const script = fileURLToPath(new URL('../server/validate-config.mjs', import.meta.url))

const valid = {
  NUXT_OIDC_ISSUER: 'https://idm.example.org/oauth2/openid/web-calendar',
  NUXT_TOKEN_HASH_KEY: 'k'.repeat(32),
  NUXT_RADICALE_URL: 'http://radicale:5232',
  NUXT_GROUP_SYNC_TOKEN: 'sync-token',
}

describe('validateEnv', () => {
  it('accepts a complete configuration without warnings', () => {
    expect(validateEnv(valid)).toEqual({ errors: [], warnings: [] })
  })

  it('reports every missing required variable', () => {
    const { errors } = validateEnv({})
    expect(errors).toHaveLength(3)
    expect(errors.join('\n')).toContain('NUXT_OIDC_ISSUER')
    expect(errors.join('\n')).toContain('NUXT_TOKEN_HASH_KEY')
    expect(errors.join('\n')).toContain('NUXT_RADICALE_URL')
  })

  it('treats blank values as missing', () => {
    const { errors } = validateEnv({ ...valid, NUXT_TOKEN_HASH_KEY: '   ' })
    expect(errors).toEqual(['NUXT_TOKEN_HASH_KEY is required'])
  })

  describe('TZ (organization time zone)', () => {
    const check = (zone: string | undefined) => validateEnv({ ...valid, TZ: zone }).errors

    it('accepts an unset value and IANA zones', () => {
      expect(check(undefined)).toEqual([])
      expect(check('')).toEqual([])
      expect(check('Europe/Berlin')).toEqual([])
      expect(check('America/New_York')).toEqual([])
      expect(check('UTC')).toEqual([])
    })

    it('rejects anything that is not a zone', () => {
      expect(check('Mars/Olympus')).toEqual([
        'TZ must be an IANA time zone such as Europe/Berlin, not "Mars/Olympus"',
      ])
    })
  })

  describe('NUXT_OIDC_ISSUER', () => {
    const check = (issuer: string, extra: Record<string, string> = {}) =>
      validateEnv({ ...valid, NUXT_OIDC_ISSUER: issuer, ...extra }).errors

    it('rejects a value that is not a URL', () => {
      expect(check('idm.example.org')).toEqual(['NUXT_OIDC_ISSUER is not a valid URL'])
    })

    it('rejects http', () => {
      expect(check('http://idm.example.org/oauth2/openid/web-calendar')).toEqual([
        'NUXT_OIDC_ISSUER must be an https URL',
      ])
    })

    it('rejects a trailing slash', () => {
      expect(check('https://idm.example.org/oauth2/openid/web-calendar/')).toEqual([
        'NUXT_OIDC_ISSUER must not end with a slash',
      ])
    })

    it('rejects an issuer without a client segment', () => {
      expect(check('https://idm.example.org')).toEqual([
        'NUXT_OIDC_ISSUER must end with the client id "web-calendar"',
      ])
    })

    it('rejects a client segment that differs from NUXT_OIDC_CLIENT_ID', () => {
      expect(check('https://idm.example.org/oauth2/openid/other')).toEqual([
        'NUXT_OIDC_ISSUER ends with "other", but NUXT_OIDC_CLIENT_ID is "web-calendar"',
      ])
    })

    it('compares the last segment with a configured client id', () => {
      expect(
        check('https://idm.example.org/oauth2/openid/team-cal', {
          NUXT_OIDC_CLIENT_ID: 'team-cal',
        }),
      ).toEqual([])
    })
  })

  describe('NUXT_TOKEN_HASH_KEY', () => {
    it('rejects a key shorter than 32 characters', () => {
      const { errors } = validateEnv({ ...valid, NUXT_TOKEN_HASH_KEY: 'k'.repeat(31) })
      expect(errors).toEqual(['NUXT_TOKEN_HASH_KEY must have at least 32 characters'])
    })

    it('never echoes the key', () => {
      const key = 'secret-short-key'
      const { errors } = validateEnv({ ...valid, NUXT_TOKEN_HASH_KEY: key })
      expect(errors.join('\n')).not.toContain(key)
    })
  })

  describe('NUXT_RADICALE_URL', () => {
    it('accepts http and https', () => {
      expect(
        validateEnv({ ...valid, NUXT_RADICALE_URL: 'https://radicale.internal' }).errors,
      ).toEqual([])
    })

    it('rejects other schemes and non-URLs', () => {
      const expected = ['NUXT_RADICALE_URL must be an http or https URL']
      expect(validateEnv({ ...valid, NUXT_RADICALE_URL: 'ftp://radicale' }).errors).toEqual(
        expected,
      )
      expect(validateEnv({ ...valid, NUXT_RADICALE_URL: 'radicale' }).errors).toEqual(expected)
    })
  })

  it('warns, but does not fail, when the group sync token is missing', () => {
    const { errors, warnings } = validateEnv({ ...valid, NUXT_GROUP_SYNC_TOKEN: '' })
    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('NUXT_GROUP_SYNC_TOKEN')
  })
})

describe('validate-config.mjs as a script', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script], { env, encoding: 'utf8' })

  it('exits 0 and passes a valid environment', () => {
    const result = run(valid)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Validation passed')
  })

  it('exits 1 and lists the problems', () => {
    const result = run({})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NUXT_OIDC_ISSUER is required')
  })

  it('prints a warning for a missing group sync token and still exits 0', () => {
    const result = run({ ...valid, NUXT_GROUP_SYNC_TOKEN: '' })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('NUXT_GROUP_SYNC_TOKEN')
  })

  it('has no side effects when imported', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(script)}); console.log('imported')`,
      ],
      { env: {}, encoding: 'utf8' },
    )
    expect(out.trim()).toBe('imported')
  })
})
