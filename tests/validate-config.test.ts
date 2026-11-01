// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../server/validate-config.mjs'
import { ALLOW_PRIVATE_ACK_VARIABLE } from '../server/utils/ical-proxy/config'

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

  describe('optional numbers', () => {
    const check = (name: string, value: string | undefined) =>
      validateEnv({ ...valid, ...(value === undefined ? {} : { [name]: value }) }).errors

    it.each([
      ['NUXT_OIDC_KEY_MAX_AGE_SEC', 1],
      ['NUXT_GATEWAY_MAX_BODY_BYTES', 1],
      ['NUXT_ICAL_PROXY_CACHE_TTL_SEC', 0],
      ['NUXT_ICAL_PROXY_MAX_BYTES', 1],
      ['NUXT_ICAL_PROXY_TIMEOUT_MS', 1],
    ])('%s: unset, the minimum and a normal value pass', (name, min) => {
      expect(check(name, undefined)).toEqual([])
      expect(check(name, String(min))).toEqual([])
      expect(check(name, '3600')).toEqual([])
      expect(check(name, '10485760')).toEqual([])
    })

    it.each([
      ['NUXT_OIDC_KEY_MAX_AGE_SEC', 1, '0'],
      ['NUXT_GATEWAY_MAX_BODY_BYTES', 1, '0'],
      ['NUXT_ICAL_PROXY_CACHE_TTL_SEC', 0, '-1'],
      ['NUXT_ICAL_PROXY_MAX_BYTES', 1, '0'],
      ['NUXT_ICAL_PROXY_TIMEOUT_MS', 1, '0'],
    ])(
      '%s: below the minimum of %i (%s) is an error that names the variable',
      (name, min, value) => {
        expect(check(name, value)).toEqual([
          `${name} must be a whole number of at least ${min}, not "${value}"`,
        ])
      },
    )

    it.each([
      '',
      ' ',
      '1.5',
      '1e3',
      '0x10',
      '10 ',
      ' 10',
      '+5',
      '-5',
      'ten',
      'NaN',
      'Infinity',
      '9007199254740993',
      '1'.repeat(40),
    ])('rejects %j for every number', (value) => {
      for (const name of [
        'NUXT_OIDC_KEY_MAX_AGE_SEC',
        'NUXT_GATEWAY_MAX_BODY_BYTES',
        'NUXT_ICAL_PROXY_CACHE_TTL_SEC',
        'NUXT_ICAL_PROXY_MAX_BYTES',
        'NUXT_ICAL_PROXY_TIMEOUT_MS',
      ]) {
        expect(check(name, value)).toHaveLength(1)
        expect(check(name, value)[0]).toContain(name)
      }
    })

    it('shortens a very long value in the message', () => {
      expect(check('NUXT_OIDC_KEY_MAX_AGE_SEC', 'x'.repeat(500))[0]!.length).toBeLessThan(120)
    })
  })

  describe('optional booleans (only the exact text counts)', () => {
    const names = ['NUXT_GATEWAY_TRUST_FORWARDED_FOR', 'NUXT_ICAL_PROXY_ALLOW_PRIVATE', 'NUXT_DEMO']
    const check = (name: string, value: string) => validateEnv({ ...valid, [name]: value }).errors

    it.each(names)('%s accepts true and false', (name) => {
      expect(check(name, 'false')).toEqual([])
      if (name !== 'NUXT_ICAL_PROXY_ALLOW_PRIVATE') expect(check(name, 'true')).toEqual([])
      expect(validateEnv(valid).errors).toEqual([])
    })

    it.each([
      '',
      ' ',
      'True',
      'TRUE',
      'FALSE',
      'yes',
      'no',
      '1',
      '0',
      'on',
      'true ',
      ' false',
      'null',
    ])('rejects %j, which the server would read as "off" without a word', (value) => {
      for (const name of names) {
        expect(check(name, value)).toEqual([
          `${name} must be exactly "true" or "false", not ${JSON.stringify(value)}`,
        ])
      }
    })
  })

  describe('NUXT_OIDC_ADMIN_GROUP', () => {
    const check = (value: string) => validateEnv({ ...valid, NUXT_OIDC_ADMIN_GROUP: value }).errors

    it('accepts a group name or an SPN, and an unset value', () => {
      expect(check('calendar_admins')).toEqual([])
      expect(check('calendar_admins@idm.example.org')).toEqual([])
      expect(validateEnv(valid).errors).toEqual([])
    })

    it.each(['', '   ', ' calendar_admins', 'calendar_admins '])('rejects %j', (value) => {
      const errors = check(value)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_OIDC_ADMIN_GROUP')
    })
  })

  describe('NUXT_ICAL_PROXY_ALLOW_PRIVATE in production (L3)', () => {
    const run = (env: Record<string, string>) => validateEnv({ ...valid, ...env })

    it('is an error, and names the second switch', () => {
      const { errors } = run({ NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true', NODE_ENV: 'production' })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_ICAL_PROXY_ALLOW_PRIVATE=true')
      expect(errors[0]).toContain('NODE_ENV=production')
      expect(errors[0]).toContain(ALLOW_PRIVATE_ACK_VARIABLE)
    })

    it('stays an error when the second switch is anything but exactly true', () => {
      for (const value of ['', 'false', 'TRUE', 'yes', '1', ' true']) {
        const { errors } = run({
          NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true',
          NODE_ENV: 'production',
          [ALLOW_PRIVATE_ACK_VARIABLE]: value,
        })
        expect(errors).toHaveLength(1)
      }
    })

    it('is a loud warning, not an error, with the second switch', () => {
      const { errors, warnings } = run({
        NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true',
        NODE_ENV: 'production',
        [ALLOW_PRIVATE_ACK_VARIABLE]: 'true',
      })
      expect(errors).toEqual([])
      expect(warnings.join('\n')).toContain('IN PRODUCTION')
    })

    it('is a warning outside production, where tests and development run', () => {
      for (const NODE_ENV of ['development', 'test', '']) {
        const { errors, warnings } = run({ NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true', NODE_ENV })
        expect(errors).toEqual([])
        expect(warnings.join('\n')).toContain('SSRF guard')
      }
      const unset = run({ NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true' })
      expect(unset.errors).toEqual([])
    })

    it('is quiet when the guard is on', () => {
      expect(run({ NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'false', NODE_ENV: 'production' })).toEqual({
        errors: [],
        warnings: [],
      })
      expect(run({ NODE_ENV: 'production', [ALLOW_PRIVATE_ACK_VARIABLE]: 'true' })).toEqual({
        errors: [],
        warnings: [],
      })
    })
  })

  describe('NUXT_OUTBOUND_ALLOWED_HOSTS (the hosts the server may contact)', () => {
    const check = (value: string) => validateEnv({ ...valid, NUXT_OUTBOUND_ALLOWED_HOSTS: value })

    it.each(['', '  ', 'cal.example.org', '*.example.org', 'a.example.org, *.b.example.org'])(
      'accepts %j (an empty value is no list)',
      (value) => {
        expect(check(value)).toEqual({ errors: [], warnings: [] })
      },
    )

    it('is optional', () => {
      expect(validateEnv(valid).errors).toEqual([])
    })

    it.each([
      '*',
      'https://cal.example.org',
      'cal.example.org:8443',
      'cal.example.org/dav',
      'cal.example.org,',
      '*.',
      'a*.example.org',
      '1.2.3',
      'bücher.example',
    ])('refuses %j and names the variable and the entry, not a guess', (value) => {
      const { errors } = check(value)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_OUTBOUND_ALLOWED_HOSTS')
      expect(errors[0]).toContain('the entry')
    })

    it('shortens a very long entry in the message', () => {
      expect(check(`${'x'.repeat(500)}://`).errors[0]!.length).toBeLessThan(500)
    })
  })

  describe('NUXT_EXTERNAL_SEAL_KEY (seals the passwords of external accounts)', () => {
    const check = (value: string) => validateEnv({ ...valid, NUXT_EXTERNAL_SEAL_KEY: value })
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))

    it('is optional, and an empty value counts as unset (no warning: logins are simply off)', () => {
      expect(validateEnv(valid)).toEqual({ errors: [], warnings: [] })
      expect(check('')).toEqual({ errors: [], warnings: [] })
      expect(check('   ')).toEqual({ errors: [], warnings: [] })
    })

    it.each([bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url')])(
      'accepts 32 bytes written as %s',
      (value) => {
        expect(check(value)).toEqual({ errors: [], warnings: [] })
      },
    )

    it.each([
      'secret',
      'ab'.repeat(31),
      'ab'.repeat(33),
      Buffer.alloc(16, 7).toString('base64'),
      Buffer.alloc(48, 7).toString('base64'),
      '00'.repeat(32),
      'not base64 !!!',
    ])('refuses %j without printing it', (value) => {
      const { errors } = check(value)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_EXTERNAL_SEAL_KEY must be 32 random bytes')
      expect(errors[0]).not.toContain(value)
    })
  })

  describe('NUXT_DEMO', () => {
    it('warns loudly, and only for true', () => {
      const { errors, warnings } = validateEnv({ ...valid, NUXT_DEMO: 'true' })
      expect(errors).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('DEMO MODE')
      expect(warnings[0]).toContain('skips the login')
      expect(validateEnv({ ...valid, NUXT_DEMO: 'false' })).toEqual({ errors: [], warnings: [] })
    })
  })

  it('warns, but does not fail, when the group sync token is missing', () => {
    const { errors, warnings } = validateEnv({ ...valid, NUXT_GROUP_SYNC_TOKEN: '' })
    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('NUXT_GROUP_SYNC_TOKEN')
  })

  it('accepts a group sync interval from 1 to 300 seconds and refuses others', () => {
    for (const ok of ['1', '60', '300']) {
      expect(validateEnv({ ...valid, NUXT_GROUP_SYNC_INTERVAL_SEC: ok }).errors).toEqual([])
    }
    for (const bad of ['301', '3600', '0', '-5', '1.5', 'abc', '']) {
      const { errors } = validateEnv({ ...valid, NUXT_GROUP_SYNC_INTERVAL_SEC: bad })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_GROUP_SYNC_INTERVAL_SEC')
    }
    expect(validateEnv({ ...valid, NUXT_GROUP_SYNC_INTERVAL_SEC: '301' }).errors[0]).toContain(
      'at most 300',
    )
  })

  it('refuses an empty group file path but accepts a set one', () => {
    expect(validateEnv({ ...valid, NUXT_GROUP_SYNC_FILE: '/groups/htgroup' }).errors).toEqual([])
    const { errors } = validateEnv({ ...valid, NUXT_GROUP_SYNC_FILE: ' ' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('NUXT_GROUP_SYNC_FILE')
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

  it('prints the problems of a bad optional variable and exits 1', () => {
    const result = run({
      ...valid,
      NUXT_GATEWAY_TRUST_FORWARDED_FOR: 'yes',
      NUXT_ICAL_PROXY_MAX_BYTES: '0',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NUXT_GATEWAY_TRUST_FORWARDED_FOR must be exactly')
    expect(result.stderr).toContain('NUXT_ICAL_PROXY_MAX_BYTES must be a whole number')
  })

  it('refuses allowPrivate in production and passes it with the second switch', () => {
    const env = { ...valid, NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true', NODE_ENV: 'production' }
    const refused = run(env)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('SSRF guard')

    const knowing = run({ ...env, [ALLOW_PRIVATE_ACK_VARIABLE]: 'true' })
    expect(knowing.status).toBe(0)
    expect(knowing.stderr).toContain('IN PRODUCTION')
  })

  it('prints the demo warning and still exits 0', () => {
    const result = run({ ...valid, NUXT_DEMO: 'true' })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('DEMO MODE')
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

describe('the examples list what the validator knows (L2)', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const envExample = read('../.env.example')
  const compose = read('../docker-compose.yml')

  const optional = [
    'NUXT_OIDC_ADMIN_GROUP',
    'NUXT_OIDC_KEY_MAX_AGE_SEC',
    'NUXT_GATEWAY_MAX_BODY_BYTES',
    'NUXT_GATEWAY_TRUST_FORWARDED_FOR',
    'NUXT_ICAL_PROXY_CACHE_TTL_SEC',
    'NUXT_ICAL_PROXY_MAX_BYTES',
    'NUXT_ICAL_PROXY_TIMEOUT_MS',
    'NUXT_ICAL_PROXY_ALLOW_PRIVATE',
    'NUXT_DEMO',
  ]

  it.each(optional)('%s is in .env.example and in docker-compose.yml', (name) => {
    expect(envExample).toMatch(new RegExp(`^#? ?${name}=`, 'm'))
    expect(compose).toMatch(new RegExp(`^\\s+${name}: `, 'm'))
  })

  it.each(['NUXT_OUTBOUND_ALLOWED_HOSTS', 'NUXT_EXTERNAL_SEAL_KEY'])(
    '%s (empty by default) is in .env.example and in docker-compose.yml',
    (name) => {
      expect(envExample).toMatch(new RegExp(`^#? ?${name}=`, 'm'))
      expect(compose).toMatch(new RegExp(`^\\s+${name}: '\\$\\{${name}:-\\}'`, 'm'))
    },
  )

  it('says what the host list is for, and that the seal key voids the seals when changed', () => {
    expect(envExample).toMatch(/script[\s\S]{0,1500}# NUXT_OUTBOUND_ALLOWED_HOSTS=/i)
    expect(envExample).toMatch(/voids[\s\S]{0,800}# NUXT_EXTERNAL_SEAL_KEY=/i)
  })

  it('every variable the validator checks has a default that passes', () => {
    // Compose fills an empty value with the default after `:-`; each one must be valid.
    const defaults = [...compose.matchAll(/^\s+(NUXT_[A-Z_]+): '\$\{\1:-([^}]*)\}'/gm)].map(
      ([, name, value]) => [name!, value!] as const,
    )
    const env = Object.fromEntries(defaults.filter(([, value]) => value !== ''))
    expect(Object.keys(env)).toEqual(expect.arrayContaining(optional))
    expect(validateEnv({ ...valid, ...env })).toEqual({ errors: [], warnings: [] })
  })

  it('never lists the second allowPrivate switch, and says allowPrivate is for tests only', () => {
    expect(envExample).not.toContain(ALLOW_PRIVATE_ACK_VARIABLE)
    expect(compose).not.toContain(ALLOW_PRIVATE_ACK_VARIABLE)
    expect(envExample).toMatch(/NUXT_ICAL_PROXY_ALLOW_PRIVATE[\s\S]{0,400}tests only/i)
  })

  it('explains NUXT_GATEWAY_TRUST_FORWARDED_FOR with the proxy it depends on', () => {
    expect(envExample).toMatch(
      /reverse proxy[\s\S]*X-Forwarded-For|X-Forwarded-For[\s\S]*reverse proxy/i,
    )
    expect(compose).toMatch(/NUXT_GATEWAY_TRUST_FORWARDED_FOR/)
  })

  it('the health check exercises the verifier wiring and keeps its start_interval', () => {
    const health = compose.slice(
      compose.indexOf('healthcheck:'),
      compose.indexOf('radicale:\n    image'),
    )
    expect(health).toContain('/api/config')
    expect(health).toContain('/caldav/')
    expect(health).toContain('401')
    expect(health).toMatch(/start_interval: 2s/)
  })
})
