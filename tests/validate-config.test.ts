// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OUTBOUND_OPEN_MESSAGE, validateEnv } from '../server/validate-config.mjs'
import { ALLOW_PRIVATE_ACK_VARIABLE, outboundScopeError } from '../server/utils/ical-proxy/config'

const script = fileURLToPath(new URL('../server/validate-config.mjs', import.meta.url))

const valid = {
  NUXT_OIDC_ISSUER: 'https://idm.example.org/oauth2/openid/web-calendar',
  NUXT_TOKEN_HASH_KEY: 'k'.repeat(32),
  NUXT_RADICALE_URL: 'http://radicale:5232',
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

    const warnings = (issuer: string, extra: Record<string, string> = {}) =>
      validateEnv({ ...valid, NUXT_OIDC_ISSUER: issuer, ...extra }).warnings

    it('takes a trailing slash: the issuer is used as the provider writes it (Auth0, Authentik)', () => {
      expect(check('https://tenant.auth0.example/')).toEqual([])
      expect(check('https://idm.example.org/application/o/calendar/')).toEqual([])
    })

    it('takes issuers of other providers, which have no client segment', () => {
      for (const issuer of [
        'https://idm.example.org',
        'https://keycloak.example.org/realms/team',
        'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbCdEf',
        'https://login.microsoftonline.com/6f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77/v2.0',
      ]) {
        expect(check(issuer), issuer).toEqual([])
        expect(warnings(issuer), issuer).toEqual([])
      }
    })

    it('takes a client segment that differs from NUXT_OIDC_CLIENT_ID', () => {
      expect(check('https://idm.example.org/oauth2/openid/other')).toEqual([])
    })

    it('rejects a query or a fragment', () => {
      for (const issuer of [
        'https://idm.example.org/realms/team?x=1',
        'https://idm.example.org/realms/team#top',
        'https://idm.example.org/realms/team?',
      ]) {
        expect(check(issuer), issuer).toEqual([
          'NUXT_OIDC_ISSUER must not have a query or a fragment',
        ])
      }
    })

    it('warns about further clients only where the issuer does not end with the client id', () => {
      const further = { NUXT_OIDC_ALLOWED_CLIENTS: 'web-calendar, other-app' }
      // Kanidm layout: one issuer per client, derived from this one. Nothing to say.
      expect(warnings('https://idm.example.org/oauth2/openid/web-calendar', further)).toEqual([])
      // Any other layout: all the clients share the issuer.
      const shared = warnings('https://keycloak.example.org/realms/team', further)
      expect(shared).toHaveLength(1)
      expect(shared[0]).toContain('other-app')
      expect(shared[0]).toContain('share')
      expect(warnings('https://tenant.auth0.example/', further)).toHaveLength(1)
      // No further client: no remark.
      expect(warnings('https://keycloak.example.org/realms/team')).toEqual([])
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
      ['NUXT_GATEWAY_MAX_CONCURRENT_PER_USER', 1],
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
      ['NUXT_GATEWAY_MAX_CONCURRENT_PER_USER', 1, '0'],
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
        'NUXT_GATEWAY_MAX_CONCURRENT_PER_USER',
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
    const names = [
      'NUXT_GATEWAY_TRUST_FORWARDED_FOR',
      'NUXT_ICAL_PROXY_ALLOW_PRIVATE',
      'NUXT_OUTBOUND_ALLOW_ANY_HOST',
      'NUXT_DEMO',
    ]
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

    it('accepts a group name, an SPN, a path or an id, and an unset value', () => {
      expect(check('calendar_admins')).toEqual([])
      expect(check('calendar_admins@idm.example.org')).toEqual([])
      expect(check('/team/calendar-admins')).toEqual([])
      expect(check('6f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77')).toEqual([])
      expect(validateEnv(valid).errors).toEqual([])
    })

    it.each(['', '   ', ' calendar_admins', 'calendar_admins '])('rejects %j', (value) => {
      const errors = check(value)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_OIDC_ADMIN_GROUP')
    })
  })

  describe('NUXT_SIGNIN_WINDOW_DAYS', () => {
    const run = (value: string) => validateEnv({ ...valid, NUXT_SIGNIN_WINDOW_DAYS: value })

    it('is fine unset, and from 1 to 365 days with spaces around it', () => {
      expect(validateEnv(valid).errors).toEqual([])
      for (const days of ['1', '30', '365', ' 7 ']) expect(run(days).errors).toEqual([])
    })

    it('takes an empty value as the default, as the server does (a form field left empty)', () => {
      for (const days of ['', '  ']) expect(run(days).errors).toEqual([])
    })

    it.each(['0', '366', '-1', '1.5', '30d', 'many', '1e2', '+5', '0x10', '99999'])(
      'refuses %j, saying what is allowed',
      (value) => {
        const { errors } = run(value)
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain('NUXT_SIGNIN_WINDOW_DAYS')
        expect(errors[0]).toContain('1 to 365')
      },
    )
  })

  describe('NUXT_OIDC_GROUPS_CLAIM and NUXT_OIDC_GROUPS_IGNORE', () => {
    const claim = (value: string) => validateEnv({ ...valid, NUXT_OIDC_GROUPS_CLAIM: value })
    const ignore = (value: string) => validateEnv({ ...valid, NUXT_OIDC_GROUPS_IGNORE: value })

    it('are fine unset, and the claim may be a namespaced name', () => {
      expect(validateEnv(valid)).toMatchObject({ errors: [], warnings: [] })
      for (const name of [
        'groups',
        'cognito:groups',
        'https://example.org/claims/groups',
        'urn:x:y',
      ]) {
        expect(claim(name).errors).toEqual([])
      }
    })

    it('takes an empty claim name as the default, as the server does', () => {
      expect(claim('').errors).toEqual([])
    })

    it.each([' ', 'two words', 'tab\tin', 'x'.repeat(201), 'ünicode'])(
      'refuses the claim name %j',
      (value) => {
        const { errors } = claim(value)
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain('NUXT_OIDC_GROUPS_CLAIM')
      },
    )

    it('takes names and prefix patterns, with blanks and empty entries tolerated', () => {
      expect(ignore('idm_*, system_* ,,domain_*, staff').errors).toEqual([])
      expect(ignore('').errors).toEqual([])
    })

    it.each(['*', 'a b', 'a*b', 'a/b', 'ünicode', 'x**', 'good, bad name'])(
      'refuses the ignore entry %j, naming the setting',
      (value) => {
        const { errors } = ignore(value)
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain('NUXT_OIDC_GROUPS_IGNORE')
      },
    )
  })

  describe('NUXT_OIDC_JWKS_HOSTS', () => {
    const run = (value: string) => validateEnv({ ...valid, NUXT_OIDC_JWKS_HOSTS: value })

    it('is empty by default, and says nothing when empty', () => {
      expect(validateEnv(valid)).toMatchObject({ errors: [], warnings: [] })
      expect(run('')).toMatchObject({ errors: [], warnings: [] })
      expect(run(' , ')).toMatchObject({ errors: [], warnings: [] })
    })

    it('takes exact host names, in any case, and says at every start which it trusts', () => {
      const { errors, warnings } = run('www.googleapis.com, Login.MicrosoftOnline.com,')
      expect(errors).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('www.googleapis.com, login.microsoftonline.com')
    })

    it.each([
      '*.googleapis.com',
      '*',
      'https://www.googleapis.com',
      'www.googleapis.com/oauth2',
      'www.googleapis.com:443',
      'user@www.googleapis.com',
      'two words',
      'under_score.example.test',
      '-bad.example.test',
      '1.2.3',
    ])('rejects %j', (value) => {
      const { errors } = run(`ok.example.test, ${value}`)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_OIDC_JWKS_HOSTS')
    })
  })

  describe('NUXT_OIDC_SCOPE, NUXT_OIDC_REQUIRED_SCOPE and NUXT_OIDC_AUDIENCE', () => {
    const check = (env: Record<string, string>) => validateEnv({ ...valid, ...env }).errors

    it('accept sensible values and unset ones', () => {
      expect(check({ NUXT_OIDC_SCOPE: 'openid profile email groups caldav' })).toEqual([])
      expect(check({ NUXT_OIDC_SCOPE: 'openid api://6f1c2b0e/caldav' })).toEqual([])
      expect(check({ NUXT_OIDC_REQUIRED_SCOPE: 'calendar/caldav' })).toEqual([])
      expect(check({ NUXT_OIDC_AUDIENCE: '' })).toEqual([])
      expect(
        check({ NUXT_OIDC_AUDIENCE: 'https://calendar.example.org/api, api://calendar,' }),
      ).toEqual([])
    })

    it.each(['', '   ', 'profile email caldav'])('reject the scope %j without openid', (scope) => {
      const errors = check({ NUXT_OIDC_SCOPE: scope })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_OIDC_SCOPE')
    })

    it.each(['', ' ', 'two words', ' caldav', 'caldav ', 'cal\tdav'])(
      'reject the required scope %j',
      (scope) => {
        const errors = check({ NUXT_OIDC_REQUIRED_SCOPE: scope })
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain('NUXT_OIDC_REQUIRED_SCOPE')
      },
    )

    it.each(['https://api example.org', 'a, b c', 'a\u0000b'])(
      'reject the audience %j',
      (value) => {
        const errors = check({ NUXT_OIDC_AUDIENCE: value })
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain('NUXT_OIDC_AUDIENCE')
      },
    )
  })

  describe('NUXT_ICAL_PROXY_ALLOW_PRIVATE in production (L3)', () => {
    // A host list, so that production does not also complain about an open outbound scope.
    const run = (env: Record<string, string>) =>
      validateEnv({ ...valid, NUXT_OUTBOUND_ALLOWED_HOSTS: 'cal.example.org', ...env })

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

  describe('an open outbound scope in production (security review 2026-11-01, finding 1)', () => {
    const run = (env: Record<string, string>) => validateEnv({ ...valid, ...env })

    it('is an error: production with no host list and no NUXT_OUTBOUND_ALLOW_ANY_HOST', () => {
      const { errors } = run({ NODE_ENV: 'production' })
      expect(errors).toEqual([OUTBOUND_OPEN_MESSAGE])
      expect(errors[0]).toContain('NUXT_OUTBOUND_ALLOW_ANY_HOST=true')
    })

    it('uses the same words as the server does when it starts', () => {
      expect(outboundScopeError({ production: true, hostCount: 0, allowAnyHost: false })).toBe(
        OUTBOUND_OPEN_MESSAGE,
      )
    })

    it.each(['', 'false', 'TRUE', 'yes', '1', ' true'])(
      'stays an error when NUXT_OUTBOUND_ALLOW_ANY_HOST is %j',
      (value) => {
        const { errors } = run({ NODE_ENV: 'production', NUXT_OUTBOUND_ALLOW_ANY_HOST: value })
        expect(errors.length).toBeGreaterThan(0)
        if (value !== '' && value !== 'false') {
          expect(errors.join('\n')).toContain('must be exactly "true" or "false"')
        }
      },
    )

    it('is a warning, not an error, once it is allowed knowingly', () => {
      const { errors, warnings } = run({
        NODE_ENV: 'production',
        NUXT_OUTBOUND_ALLOW_ANY_HOST: 'true',
      })
      expect(errors).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('any public host')
    })

    it('is quiet with a host list, and says the switch does nothing next to a list', () => {
      expect(
        run({ NODE_ENV: 'production', NUXT_OUTBOUND_ALLOWED_HOSTS: 'cal.example.org' }),
      ).toEqual({
        errors: [],
        warnings: [],
      })
      const both = run({
        NODE_ENV: 'production',
        NUXT_OUTBOUND_ALLOWED_HOSTS: 'cal.example.org',
        NUXT_OUTBOUND_ALLOW_ANY_HOST: 'true',
      })
      expect(both.errors).toEqual([])
      expect(both.warnings.join('\n')).toContain('has no effect')
    })

    it('does not apply outside production, where development and tests run', () => {
      for (const NODE_ENV of ['development', 'test', '']) {
        expect(run({ NODE_ENV })).toEqual({ errors: [], warnings: [] })
      }
      expect(run({})).toEqual({ errors: [], warnings: [] })
    })

    it('does not add its own error to a list that cannot be used', () => {
      const { errors } = run({ NODE_ENV: 'production', NUXT_OUTBOUND_ALLOWED_HOSTS: '*' })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('cannot be used')
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

  describe('one purpose per key (security review 2026-11-01, finding 5)', () => {
    const sealKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('hex')

    it('refuses the token hash key reused as the seal key', () => {
      const shared = 'k'.repeat(32)
      expect(
        validateEnv({ ...valid, NUXT_TOKEN_HASH_KEY: shared, NUXT_EXTERNAL_SEAL_KEY: shared })
          .errors,
      ).toContain(
        'NUXT_TOKEN_HASH_KEY(S) and NUXT_EXTERNAL_SEAL_KEY must not be the same value: each secret has one purpose',
      )
    })

    it('does not mind two DIFFERENT token hash key versions sharing a purpose', () => {
      expect(
        validateEnv({ ...valid, NUXT_TOKEN_HASH_KEYS: `1:${valid.NUXT_TOKEN_HASH_KEY}` }).errors,
      ).toEqual([])
    })

    it('accepts two different values', () => {
      expect(validateEnv({ ...valid, NUXT_EXTERNAL_SEAL_KEY: sealKey })).toEqual({
        errors: [],
        warnings: [],
      })
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

  describe('the removed group sync settings', () => {
    it('warns, but does not fail, for each one that is still set, and names them without values', () => {
      const { errors, warnings } = validateEnv({
        ...valid,
        NUXT_GROUP_SYNC_TOKEN: 'sync-token-secret',
        NUXT_GROUP_SYNC_INTERVAL_SEC: '60',
        NUXT_GROUP_SYNC_FILE: '/groups/htgroup',
      })
      expect(errors).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(
        'NUXT_GROUP_SYNC_FILE, NUXT_GROUP_SYNC_INTERVAL_SEC, NUXT_GROUP_SYNC_TOKEN are set but ignored',
      )
      expect(warnings[0]).toContain('sign-in claim')
      expect(warnings[0]).toContain('NUXT_GROUPS_FILE')
      expect(warnings[0]).not.toContain('sync-token-secret')
    })

    it('warns for a single one, an empty one included, and never refuses its value', () => {
      for (const value of ['', ' ', '301', 'abc']) {
        const { errors, warnings } = validateEnv({ ...valid, NUXT_GROUP_SYNC_INTERVAL_SEC: value })
        expect(errors).toEqual([])
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('NUXT_GROUP_SYNC_INTERVAL_SEC is set but ignored')
        expect(warnings[0]).toContain('Remove it')
      }
    })

    it('is quiet when none is set, and the token no longer takes part in the key check', () => {
      expect(validateEnv(valid).warnings).toEqual([])
      const shared = 'k'.repeat(32)
      expect(validateEnv({ ...valid, NUXT_GROUP_SYNC_TOKEN: shared }).errors).toEqual([])
    })
  })

  describe('NUXT_GROUPS_FILE', () => {
    it('accepts a set file path and an unset one', () => {
      expect(validateEnv({ ...valid, NUXT_GROUPS_FILE: '/groups/htgroup' })).toEqual({
        errors: [],
        warnings: [],
      })
      expect(validateEnv(valid).errors).toEqual([])
    })

    it.each(['', ' ', '  \t '])('refuses the empty path %j', (value) => {
      const { errors } = validateEnv({ ...valid, NUXT_GROUPS_FILE: value })
      expect(errors).toEqual([
        'NUXT_GROUPS_FILE must be a file path; leave it unset for the default',
      ])
    })
  })
})

describe('validateEnv: booking reconcile', () => {
  it('accepts an interval from 1 to 900 seconds and refuses others', () => {
    for (const ok of ['1', '300', '900']) {
      expect(validateEnv({ ...valid, NUXT_RESOURCES_RECONCILE_INTERVAL_SEC: ok }).errors).toEqual(
        [],
      )
    }
    for (const bad of ['901', '0', '-1', 'abc', '']) {
      const { errors } = validateEnv({ ...valid, NUXT_RESOURCES_RECONCILE_INTERVAL_SEC: bad })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_RESOURCES_RECONCILE_INTERVAL_SEC')
    }
  })

  it('takes the manager cancel flag as exactly true or false', () => {
    for (const ok of ['true', 'false']) {
      expect(validateEnv({ ...valid, NUXT_RESOURCES_MANAGER_CANCEL: ok }).errors).toEqual([])
    }
    for (const bad of ['yes', '1', '']) {
      const { errors } = validateEnv({ ...valid, NUXT_RESOURCES_MANAGER_CANCEL: bad })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_RESOURCES_MANAGER_CANCEL')
    }
  })
})

describe('validateEnv: sharing writer', () => {
  it('accepts a reconcile interval from 1 to 900 seconds and refuses others', () => {
    for (const ok of ['1', '300', '900']) {
      expect(validateEnv({ ...valid, NUXT_SHARING_RECONCILE_INTERVAL_SEC: ok }).errors).toEqual([])
    }
    for (const bad of ['901', '0', '-1', '1.5', 'abc', '']) {
      const { errors } = validateEnv({ ...valid, NUXT_SHARING_RECONCILE_INTERVAL_SEC: bad })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_SHARING_RECONCILE_INTERVAL_SEC')
    }
  })

  it('accepts an audit interval from 1 to 168 hours and refuses others', () => {
    for (const ok of ['1', '24', '168']) {
      expect(validateEnv({ ...valid, NUXT_SHARING_AUDIT_INTERVAL_HOURS: ok }).errors).toEqual([])
    }
    for (const bad of ['169', '0', 'x']) {
      const { errors } = validateEnv({ ...valid, NUXT_SHARING_AUDIT_INTERVAL_HOURS: bad })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_SHARING_AUDIT_INTERVAL_HOURS')
    }
  })

  it('accepts service principals that start with _ and refuses others', () => {
    expect(validateEnv({ ...valid, NUXT_SHARING_SHARED_OWNERS: '_team, _lab' }).errors).toEqual([])
    for (const bad of ['team', '_resources', '_a/b', '_']) {
      const { errors } = validateEnv({ ...valid, NUXT_SHARING_SHARED_OWNERS: bad })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('NUXT_SHARING_SHARED_OWNERS')
    }
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

  it('prints a warning for a removed group sync setting and still exits 0', () => {
    const result = run({ ...valid, NUXT_GROUP_SYNC_TOKEN: 'sync-token-secret' })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('NUXT_GROUP_SYNC_TOKEN is set but ignored')
    expect(result.stderr).not.toContain('sync-token-secret')
  })

  it('exits 1 for an empty NUXT_GROUPS_FILE', () => {
    const result = run({ ...valid, NUXT_GROUPS_FILE: ' ' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NUXT_GROUPS_FILE must be a file path')
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
    const env = {
      ...valid,
      NUXT_OUTBOUND_ALLOWED_HOSTS: 'cal.example.org',
      NUXT_ICAL_PROXY_ALLOW_PRIVATE: 'true',
      NODE_ENV: 'production',
    }
    const refused = run(env)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('SSRF guard')

    const knowing = run({ ...env, [ALLOW_PRIVATE_ACK_VARIABLE]: 'true' })
    expect(knowing.status).toBe(0)
    expect(knowing.stderr).toContain('IN PRODUCTION')
  })

  it('refuses an open outbound scope in production and passes it with the switch or a list', () => {
    const env = { ...valid, NODE_ENV: 'production' }
    const refused = run(env)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('NUXT_OUTBOUND_ALLOW_ANY_HOST=true')

    expect(run({ ...env, NUXT_OUTBOUND_ALLOWED_HOSTS: 'cal.example.org' }).status).toBe(0)
    const knowing = run({ ...env, NUXT_OUTBOUND_ALLOW_ANY_HOST: 'true' })
    expect(knowing.status).toBe(0)
    expect(knowing.stderr).toContain('any public host')
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
    'NUXT_OIDC_SCOPE',
    'NUXT_OIDC_REQUIRED_SCOPE',
    'NUXT_OIDC_GROUPS_CLAIM',
    'NUXT_OIDC_GROUPS_IGNORE',
    'NUXT_OIDC_KEY_MAX_AGE_SEC',
    'NUXT_SIGNIN_WINDOW_DAYS',
    'NUXT_GATEWAY_MAX_BODY_BYTES',
    'NUXT_GATEWAY_MAX_CONCURRENT_PER_USER',
    'NUXT_GATEWAY_TRUST_FORWARDED_FOR',
    'NUXT_ICAL_PROXY_CACHE_TTL_SEC',
    'NUXT_ICAL_PROXY_MAX_BYTES',
    'NUXT_ICAL_PROXY_TIMEOUT_MS',
    'NUXT_ICAL_PROXY_ALLOW_PRIVATE',
    'NUXT_OUTBOUND_ALLOW_ANY_HOST',
    'NUXT_DEMO',
  ]

  it.each(optional)('%s is in .env.example and in docker-compose.yml', (name) => {
    expect(envExample).toMatch(new RegExp(`^#? ?${name}=`, 'm'))
    expect(compose).toMatch(new RegExp(`^\\s+${name}: `, 'm'))
  })

  it.each([
    'NUXT_OUTBOUND_ALLOWED_HOSTS',
    'NUXT_EXTERNAL_SEAL_KEY',
    'NUXT_OIDC_AUDIENCE',
    'NUXT_OIDC_JWKS_HOSTS',
  ])('%s (empty by default) is in .env.example and in docker-compose.yml', (name) => {
    expect(envExample).toMatch(new RegExp(`^#? ?${name}=`, 'm'))
    expect(compose).toMatch(new RegExp(`^\\s+${name}: '\\$\\{${name}:-\\}'`, 'm'))
  })

  it('says what the host list is for, and that the seal key voids the seals when changed', () => {
    expect(envExample).toMatch(/script[\s\S]{0,1500}# NUXT_OUTBOUND_ALLOWED_HOSTS=/i)
    expect(envExample).toMatch(/voids[\s\S]{0,800}# NUXT_EXTERNAL_SEAL_KEY=/i)
  })

  it('lists NUXT_GROUPS_FILE and no longer any group sync setting', () => {
    expect(envExample).toMatch(/^#? ?NUXT_GROUPS_FILE=/m)
    expect(compose).toMatch(/^\s+NUXT_GROUPS_FILE: \/groups\/htgroup$/m)
    expect(envExample).not.toContain('GROUP_SYNC')
    expect(compose).not.toContain('GROUP_SYNC')
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
