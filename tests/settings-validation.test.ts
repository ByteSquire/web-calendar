// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_SUBSCRIPTION_NAME_LENGTH,
  MAX_TOKEN_LABEL_LENGTH,
  MAX_URL_LENGTH,
  validateSubscriptionForm,
  validateSubscriptionName,
  validateSubscriptionUrl,
  validateTokenLabel,
} from '../app/utils/settings/validation'

describe('validateTokenLabel', () => {
  it.each([
    ['Thunderbird', undefined],
    ['  DAVx5 on my phone  ', undefined],
    ['x', undefined],
    ['x'.repeat(MAX_TOKEN_LABEL_LENGTH), undefined],
    // the server trims first, so spaces around the label do not count
    [` ${'x'.repeat(MAX_TOKEN_LABEL_LENGTH)} `, undefined],
    ['', /Enter a label/],
    ['   ', /Enter a label/],
    ['x'.repeat(MAX_TOKEN_LABEL_LENGTH + 1), /at most 64 characters/],
  ])('%j', (value, expected) => {
    const message = validateTokenLabel(value)
    if (expected === undefined) expect(message).toBeUndefined()
    else expect(message).toMatch(expected)
  })
})

describe('validateSubscriptionName', () => {
  it.each([
    ['Holidays', undefined],
    ['x'.repeat(MAX_SUBSCRIPTION_NAME_LENGTH), undefined],
    ['', /Enter a name/],
    [' \t', /Enter a name/],
    ['x'.repeat(MAX_SUBSCRIPTION_NAME_LENGTH + 1), /at most 80 characters/],
  ])('%j', (value, expected) => {
    const message = validateSubscriptionName(value)
    if (expected === undefined) expect(message).toBeUndefined()
    else expect(message).toMatch(expected)
  })
})

// The server (source-url.ts) decides in the end; these are the cases the browser can already tell.
describe('validateSubscriptionUrl', () => {
  it.each([
    'https://example.org/calendar.ics',
    'http://example.org/calendar.ics',
    'HTTPS://EXAMPLE.ORG/A.ICS',
    'webcal://example.org/calendar.ics',
    'WEBCAL://example.org/calendar.ics',
    '  https://example.org/a.ics  ',
    'https://example.org:8443/a.ics?token=abc#fragment',
    'https://calendar.google.com/calendar/ical/x%40group.calendar.google.com/private-abc/basic.ics',
    'https://192.168.1.10/a.ics', // private hosts are the server's call, it knows the policy
  ])('accepts %s', (value) => {
    expect(validateSubscriptionUrl(value)).toBeUndefined()
  })

  it.each([
    ['', /Enter the address/],
    ['   ', /Enter the address/],
    ['example.org/calendar.ics', /valid address/],
    ['not a url', /valid address/],
    ['https://', /valid address/],
    ['webcal://', /valid address/],
    ['ftp://example.org/a.ics', /must start with http/],
    ['file:///etc/passwd', /must start with http/],
    ['javascript:alert(1)', /must start with http/],
    ['data:text/calendar,BEGIN:VCALENDAR', /must start with http/],
    ['webcals://example.org/a.ics', /must start with http/],
    ['https://user:secret@example.org/a.ics', /user name or password/],
    ['https://user@example.org/a.ics', /user name or password/],
    ['webcal://user:secret@example.org/a.ics', /user name or password/],
    [`https://${'a'.repeat(254)}.org/a.ics`, /host name/],
    [`https://example.org/${'a'.repeat(MAX_URL_LENGTH)}`, /at most 2000 characters/],
  ])('rejects %j', (value, message) => {
    expect(validateSubscriptionUrl(value)).toMatch(message)
  })

  it('does not echo the address (it can hold a secret)', () => {
    const message = validateSubscriptionUrl('https://user:secret@example.org/a.ics')
    expect(message).not.toContain('secret')
  })
})

describe('validateSubscriptionForm', () => {
  it('reports every problem at once', () => {
    expect(validateSubscriptionForm({ name: '', url: 'nope' })).toEqual({
      name: expect.stringMatching(/Enter a name/),
      url: expect.stringMatching(/valid address/),
    })
  })

  it('is empty for a valid form', () => {
    expect(
      validateSubscriptionForm({ name: 'Holidays', url: 'webcal://example.org/a.ics' }),
    ).toEqual({})
  })
})
