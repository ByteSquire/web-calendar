// @vitest-environment node
import { ErrorResponse, ErrorTimeout } from 'oidc-client-ts'
import { describe, expect, it } from 'vitest'
import { AuthConfigError, AuthRequiredError, describeAuthError } from '../app/utils/auth/errors'

describe('describeAuthError', () => {
  // The real classes of the library, so a renamed marker would show here.
  it.each([
    ['access_denied', 'denied'],
    ['login_required', 'denied'],
    ['consent_required', 'denied'],
    ['invalid_scope', 'other'],
    ['server_error', 'other'],
    ['invalid_grant', 'other'],
  ])('ErrorResponse %s -> %s', (code, kind) => {
    const failure = describeAuthError(new ErrorResponse({ error: code, error_description: 'x' }))
    expect(failure.kind).toBe(kind)
    expect(failure.detail).toContain(code)
  })

  it.each(['No matching state found in storage', 'No state in response', 'State does not match'])(
    'state problem: %s',
    (message) => {
      expect(describeAuthError(new Error(message)).kind).toBe('state')
    },
  )

  it.each([
    new Error('Network Error'),
    new TypeError('Failed to fetch'),
    new TypeError('NetworkError when attempting to fetch resource.'),
    new TypeError('Load failed'),
    new ErrorTimeout('Token endpoint timed out'),
  ])('network problem: %s', (error) => {
    expect(describeAuthError(error).kind).toBe('network')
  })

  it('knows a missing configuration', () => {
    expect(describeAuthError(new AuthConfigError()).kind).toBe('config')
  })

  it.each([
    [new Error('boom')],
    ['text'],
    [undefined],
    [null],
    [new AuthRequiredError('signed-out')],
  ])('anything else is a generic failure: %s', (error) => {
    const failure = describeAuthError(error)
    expect(failure.kind).toBe('other')
    expect(failure.title).not.toBe('')
    expect(failure.message).not.toBe('')
  })

  it('never puts the provider text into the message', () => {
    const failure = describeAuthError(
      new ErrorResponse({ error: 'access_denied', error_description: '<b>SECRET text</b>' }),
    )
    expect(failure.message).not.toContain('SECRET')
    expect(failure.detail).toContain('SECRET')
  })
})

describe('AuthRequiredError', () => {
  it('keeps the reason and the cause', () => {
    const cause = new Error('invalid_grant')
    const error = new AuthRequiredError('renewal-failed', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AuthRequiredError')
    expect(error.reason).toBe('renewal-failed')
    expect(error.cause).toBe(cause)
  })
})
