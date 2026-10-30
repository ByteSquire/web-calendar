import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_NAME_MAX_LENGTH,
  EXTERNAL_PASSWORD_MAX_LENGTH,
  EXTERNAL_URL_MAX_LENGTH,
  EXTERNAL_USERNAME_MAX_LENGTH,
} from '../shared/types/external'
import { toCreateBody, toUpdateBody, type ExternalFormInput } from '../app/utils/external/form'
import {
  originOf,
  passwordRequired,
  validateExternalForm,
  validateExternalName,
  validateExternalPassword,
  validateExternalUrl,
  validateExternalUsername,
} from '../app/utils/external/validation'
import { account } from './external-helpers'

// The checks of the external account form. They mirror the server's limits (shared/types/external.ts)
// and only spare a round trip.

describe('name', () => {
  it('needs something and at most the limit', () => {
    expect(validateExternalName('Work')).toBeUndefined()
    expect(validateExternalName('   ')).toMatch(/Enter a name/)
    expect(validateExternalName('x'.repeat(EXTERNAL_NAME_MAX_LENGTH))).toBeUndefined()
    expect(validateExternalName('x'.repeat(EXTERNAL_NAME_MAX_LENGTH + 1))).toContain(
      `at most ${EXTERNAL_NAME_MAX_LENGTH}`,
    )
  })
})

describe('address', () => {
  it('accepts https for either mode and http only without a login', () => {
    expect(validateExternalUrl('https://dav.example.org/', 'basic')).toBeUndefined()
    expect(validateExternalUrl('https://dav.example.org/', 'none')).toBeUndefined()
    expect(validateExternalUrl('http://dav.example.org/', 'none')).toBeUndefined()
    expect(validateExternalUrl(' https://dav.example.org/x ', 'none')).toBeUndefined()
  })

  it('says why a login needs https', () => {
    const message = validateExternalUrl('http://dav.example.org/', 'basic')
    expect(message).toContain('https://')
    expect(message).toContain('password')
  })

  it.each([
    ['', /Enter the address/],
    ['dav.example.org', /valid address/],
    ['not a url', /valid address/],
    ['ftp://dav.example.org/', /http:\/\/ or https:\/\//],
    ['webcal://dav.example.org/', /http:\/\/ or https:\/\//],
    ['javascript:alert(1)', /http:\/\/ or https:\/\//],
    ['https://me@dav.example.org/', /user name or password/],
    ['https://me:secret@dav.example.org/', /user name or password/],
    ['https://:secret@dav.example.org/', /user name or password/],
  ])('refuses %j', (value, message) => {
    expect(validateExternalUrl(value, 'none')).toMatch(message)
  })

  it('refuses an address that is too long', () => {
    const long = `https://dav.example.org/${'a'.repeat(EXTERNAL_URL_MAX_LENGTH)}`
    expect(validateExternalUrl(long, 'none')).toContain(`at most ${EXTERNAL_URL_MAX_LENGTH}`)
  })

  it('finds the origin of an address, or none', () => {
    expect(originOf('https://dav.example.org:443/a/b')).toBe('https://dav.example.org')
    expect(originOf(' http://dav.example.org:8080/x ')).toBe('http://dav.example.org:8080')
    expect(originOf('ftp://dav.example.org/')).toBeNull()
    expect(originOf('nonsense')).toBeNull()
  })
})

describe('user name and password', () => {
  it('needs a user name without a colon or control characters', () => {
    expect(validateExternalUsername('me@example.org')).toBeUndefined()
    expect(validateExternalUsername('  ')).toMatch(/Enter the user name/)
    expect(validateExternalUsername('a:b')).toContain('colon')
    expect(validateExternalUsername('a\nb')).toContain('control characters')
    expect(validateExternalUsername('x'.repeat(EXTERNAL_USERNAME_MAX_LENGTH + 1))).toContain(
      `at most ${EXTERNAL_USERNAME_MAX_LENGTH}`,
    )
  })

  it('needs a password only when asked to, and keeps its limits when given', () => {
    expect(validateExternalPassword('', true)).toMatch(/Enter the password/)
    expect(validateExternalPassword('', false)).toBeUndefined()
    expect(validateExternalPassword('pä ss:wörd', true)).toBeUndefined()
    expect(validateExternalPassword('x'.repeat(EXTERNAL_PASSWORD_MAX_LENGTH + 1), false)).toContain(
      `at most ${EXTERNAL_PASSWORD_MAX_LENGTH}`,
    )
    expect(validateExternalPassword('a\u0000b', true)).toContain('control characters')
  })
})

describe('when a password is required', () => {
  const original = account(1, {
    url: 'https://dav.example.org/dav/',
    authMode: 'basic',
    username: 'me',
  })
  const same = { url: original.url, authMode: 'basic' as const, username: 'me' }

  it('is needed for a new account with a login, never for one without', () => {
    expect(passwordRequired(same)).toBe(true)
    expect(passwordRequired({ ...same, authMode: 'none' })).toBe(false)
  })

  it('is not needed when a change leaves origin, user name and mode alone', () => {
    expect(passwordRequired(same, original)).toBe(false)
    expect(passwordRequired({ ...same, url: 'https://dav.example.org/other/' }, original)).toBe(
      false,
    )
    expect(passwordRequired({ ...same, url: 'https://DAV.example.org:443/dav/' }, original)).toBe(
      false,
    )
  })

  it('is needed when the origin, the user name or the mode changes (the old seal is void)', () => {
    expect(passwordRequired({ ...same, url: 'https://other.example.org/dav/' }, original)).toBe(
      true,
    )
    expect(passwordRequired({ ...same, url: 'https://dav.example.org:8443/dav/' }, original)).toBe(
      true,
    )
    expect(passwordRequired({ ...same, username: 'you' }, original)).toBe(true)
    expect(passwordRequired({ ...same, username: ' me ' }, original)).toBe(false)
    expect(passwordRequired(same, { ...original, authMode: 'none', username: null })).toBe(true)
  })
})

describe('the whole form', () => {
  const values = {
    name: 'Work',
    url: 'https://dav.example.org/dav/',
    authMode: 'basic' as const,
    username: 'me',
    password: 'secret',
  }
  const context = { loginsEnabled: true, passwordRequired: true }

  it('is fine when everything is', () => {
    expect(validateExternalForm(values, context)).toEqual({})
    expect(
      validateExternalForm({ ...values, authMode: 'none', username: '', password: '' }, context),
    ).toEqual({})
  })

  it('reports every problem at once, per field', () => {
    expect(
      validateExternalForm(
        { name: '', url: 'http://dav.example.org/', authMode: 'basic', username: '', password: '' },
        context,
      ),
    ).toEqual({
      name: expect.any(String),
      url: expect.stringContaining('https://'),
      username: expect.any(String),
      password: expect.any(String),
    })
  })

  it('ignores user name and password for an account without a login', () => {
    expect(
      validateExternalForm(
        { ...values, authMode: 'none', username: 'a:b', password: '\u0000' },
        context,
      ),
    ).toEqual({})
  })

  it('refuses a login when the administrator has not enabled logins', () => {
    const errors = validateExternalForm(values, { ...context, loginsEnabled: false })
    expect(errors.authMode).toContain('administrator has not enabled logins')
  })

  it('lets an empty password be when the change keeps the old one', () => {
    expect(
      validateExternalForm({ ...values, password: '' }, { ...context, passwordRequired: false }),
    ).toEqual({})
  })
})

describe('the requests made from the form', () => {
  const input: ExternalFormInput = {
    name: 'Work',
    url: 'https://dav.example.org/dav/',
    authMode: 'basic',
    username: 'me',
    password: 'secret',
    color: '#1d4ed8',
    remember: true,
  }

  it('creates with the login and the password for an account with one', () => {
    expect(toCreateBody(input)).toEqual({
      name: 'Work',
      url: 'https://dav.example.org/dav/',
      authMode: 'basic',
      username: 'me',
      password: 'secret',
      color: '#1d4ed8',
    })
  })

  it('creates without login fields for an account without one, and with no colour for ""', () => {
    const body = toCreateBody({
      ...input,
      authMode: 'none',
      username: 'x',
      password: 'y',
      color: '',
    })
    expect(body).toEqual({
      name: 'Work',
      url: 'https://dav.example.org/dav/',
      authMode: 'none',
      color: null,
    })
    expect(body).not.toHaveProperty('password')
    expect(body).not.toHaveProperty('username')
  })

  it('never sends the "remember" choice to the server', () => {
    expect(JSON.stringify(toCreateBody(input))).not.toContain('remember')
    expect(JSON.stringify(toUpdateBody(input))).not.toContain('remember')
  })

  it('changes without a password when none was typed, so the server keeps its credential', () => {
    const body = toUpdateBody({ ...input, password: '' })
    expect(body).not.toHaveProperty('password')
    expect(body).toMatchObject({ authMode: 'basic', username: 'me' })
    expect(toUpdateBody(input)).toHaveProperty('password', 'secret')
  })

  it('clears the user name when the account no longer has a login', () => {
    expect(toUpdateBody({ ...input, authMode: 'none', password: 'ignored' })).toEqual({
      name: 'Work',
      url: 'https://dav.example.org/dav/',
      authMode: 'none',
      username: null,
      color: '#1d4ed8',
    })
  })
})
