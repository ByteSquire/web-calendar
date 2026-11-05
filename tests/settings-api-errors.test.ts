// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  SUBSCRIPTION_FIELDS,
  TOKEN_FIELDS,
  describeError,
  describeFailure,
  describeSubscriptionSaveError,
  describeTokenCreateError,
  fieldProblems,
  parseApiError,
} from '../app/utils/settings/api-errors'
import { describeLinkCreateError } from '../app/utils/settings/links'

/** What `$fetch` throws for an error response of the API: the h3 body is `data`. */
function fetchError(statusCode: number, body: Record<string, unknown> = {}) {
  return Object.assign(new Error(`${statusCode}`), {
    statusCode,
    data: { statusCode, statusMessage: 'x', message: 'The server says so', ...body },
  })
}

const validation = (...fields: { field: string; message: string }[]) =>
  fetchError(400, { message: 'The request is not valid', data: { fields } })

describe('parseApiError', () => {
  it.each([
    [fetchError(400), 'validation'],
    [fetchError(401), 'signed-out'],
    [fetchError(404), 'not-found'],
    [fetchError(409), 'conflict'],
    [fetchError(500), 'server'],
    [fetchError(502), 'server'],
    // no response at all: offline, DNS, CORS
    [new TypeError('Failed to fetch'), 'network'],
    // no session: the auth wrapper refused to send (cause is an AuthRequiredError)
    [
      Object.assign(new Error('fetch failed'), { cause: { name: 'AuthRequiredError' } }),
      'signed-out',
    ],
  ])('sorts %#', (error, kind) => {
    expect(parseApiError(error).kind).toBe(kind)
  })

  it('reads the status from the response when the error has none of its own', () => {
    expect(parseApiError({ response: { status: 404 } })).toMatchObject({ status: 404 })
  })

  it('reads fields, code and reason from the nested data of the body', () => {
    const info = parseApiError(
      fetchError(409, {
        data: { code: 'duplicate', reason: 'timeout', fields: [{ field: 'url', message: 'm' }] },
      }),
    )
    expect(info).toMatchObject({
      code: 'duplicate',
      reason: 'timeout',
      fields: [{ field: 'url', message: 'm' }],
      message: 'The server says so',
    })
  })

  it('reads a body that is still text, as after `responseType: "text"`', () => {
    const body = JSON.stringify({ statusCode: 502, data: { reason: 'timeout' } })
    expect(parseApiError({ statusCode: 502, data: body })).toMatchObject({
      status: 502,
      reason: 'timeout',
    })
    expect(parseApiError({ statusCode: 502, data: '<html>Bad Gateway</html>' })).toMatchObject({
      status: 502,
      reason: null,
    })
    expect(parseApiError({ statusCode: 502, data: '[1]' }).reason).toBeNull()
  })

  it('also reads them from the top of the body', () => {
    const error = { statusCode: 502, data: { reason: 'blocked' } }
    expect(parseApiError(error).reason).toBe('blocked')
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'boom'],
    ['an object without data', {}],
    ['a body that is not an object', { statusCode: 400, data: 'oops' }],
    ['fields that are not a list', { statusCode: 400, data: { data: { fields: 'x' } } }],
    [
      'fields with the wrong types',
      { statusCode: 400, data: { data: { fields: [1, null, { field: 1, message: 2 }] } } },
    ],
  ])('survives %s', (_name, error) => {
    expect(() => parseApiError(error)).not.toThrow()
    expect(parseApiError(error).fields).toEqual([])
  })
})

describe('describeFailure and describeError', () => {
  it('words each case for people, never with a stack or a raw status text', () => {
    expect(describeFailure(parseApiError(new TypeError('Failed to fetch')))).toMatch(
      /could not be reached/,
    )
    expect(describeFailure(parseApiError(fetchError(401)))).toMatch(/signed out/)
    expect(describeFailure(parseApiError(fetchError(404)))).toMatch(/no longer exists/)
    expect(describeFailure(parseApiError(fetchError(503)))).toBe(
      'The server answered with an error (HTTP 503).',
    )
    expect(describeFailure(parseApiError(fetchError(409)))).toBe('The server says so')
  })

  it('puts the action in front', () => {
    expect(describeError(fetchError(500), 'load your app tokens')).toBe(
      'Could not load your app tokens. The server answered with an error (HTTP 500).',
    )
  })
})

describe('fieldProblems', () => {
  const info = (...fields: { field: string; message: string }[]) =>
    parseApiError(validation(...fields))

  it('starts the sentence with the name of the field', () => {
    expect(
      fieldProblems(info({ field: 'label', message: 'must not be empty' }), TOKEN_FIELDS),
    ).toEqual({ byField: { label: 'The label must not be empty.' }, other: [] })
  })

  it('rewrites the messages that only make sense next to the input', () => {
    const { byField } = fieldProblems(
      info(
        { field: 'url', message: 'must not point to a private or reserved network' },
        { field: 'name', message: 'must have at most 80 characters' },
      ),
      SUBSCRIPTION_FIELDS,
    )
    expect(byField.url).toBe(
      'This address points to a private or reserved network, which is not allowed.',
    )
    expect(byField.name).toBe('The name must have at most 80 characters.')
  })

  it('keeps the first message of a field and passes unknown fields on', () => {
    const result = fieldProblems(
      info(
        { field: 'url', message: 'is required' },
        { field: 'url', message: 'must be a string' },
        { field: 'body', message: 'must be a JSON object' },
      ),
      SUBSCRIPTION_FIELDS,
    )
    expect(result.byField).toEqual({ url: 'The address is required.' })
    expect(result.other).toEqual(['url must be a string', 'body must be a JSON object'])
  })
})

describe('describeTokenCreateError', () => {
  it('shows a rejected label under the label', () => {
    const failure = describeTokenCreateError(
      validation({ field: 'label', message: 'must have at most 64 characters' }),
    )
    expect(failure).toEqual({
      label: 'The label must have at most 64 characters.',
      alert: undefined,
      limitReached: false,
    })
  })

  it('reports the limit with the server sentence and asks for a reload of the list', () => {
    const failure = describeTokenCreateError(
      fetchError(409, {
        message: 'At most 10 app tokens are allowed per user',
        data: { code: 'limit_reached' },
      }),
    )
    expect(failure.limitReached).toBe(true)
    expect(failure.alert).toBe('At most 10 app tokens are allowed per user')
    expect(failure.label).toBeUndefined()
  })

  it.each([
    ['offline', new TypeError('Failed to fetch'), /could not be reached/],
    ['a server error', fetchError(500), /HTTP 500/],
    [
      'a body that is not valid for another field',
      validation({ field: 'body', message: 'x' }),
      /body x/,
    ],
  ])('shows %s in an alert', (_name, error, pattern) => {
    const failure = describeTokenCreateError(error)
    expect(failure.alert).toMatch(pattern)
    expect(failure.limitReached).toBe(false)
  })
})

describe('describeSubscriptionSaveError', () => {
  it.each([
    [
      'an address the server resolved to a private network',
      validation({ field: 'url', message: 'must not point to a private or reserved network' }),
      {
        byField: {
          url: 'This address points to a private or reserved network, which is not allowed.',
        },
        alert: undefined,
      },
    ],
    [
      'an address that does not resolve',
      validation({ field: 'url', message: 'has a host name that cannot be resolved' }),
      {
        byField: { url: 'The host name of this address cannot be found. Check it for typos.' },
        alert: undefined,
      },
    ],
    [
      'a wrong scheme',
      validation({ field: 'url', message: 'must start with http://, https:// or webcal://' }),
      {
        byField: { url: 'The address must start with http://, https:// or webcal://.' },
        alert: undefined,
      },
    ],
    [
      'a duplicate',
      fetchError(409, { message: 'You already subscribed', data: { code: 'duplicate' } }),
      { byField: { url: 'You already subscribed to this address.' } },
    ],
    [
      'the limit',
      fetchError(409, {
        message: 'At most 50 calendar subscriptions',
        data: { code: 'limit_reached' },
      }),
      { byField: {}, alert: 'At most 50 calendar subscriptions' },
    ],
  ])('maps %s', (_name, error, expected) => {
    expect(describeSubscriptionSaveError(error, 'add the subscription')).toEqual(expected)
  })

  it('shows problems that belong to no input in an alert and everything else with the action', () => {
    expect(
      describeSubscriptionSaveError(
        validation({ field: 'body', message: 'must be a JSON object' }),
        'add the subscription',
      ),
    ).toEqual({ byField: {}, alert: 'Could not add the subscription: body must be a JSON object.' })
    expect(describeSubscriptionSaveError(fetchError(404), 'save the subscription').alert).toMatch(
      /^Could not save the subscription\. It no longer exists/,
    )
  })
})

describe('describeLinkCreateError', () => {
  it('words each refusal the server names by a code, never with its English sentence', () => {
    const conflict = (code: string) =>
      describeLinkCreateError(fetchError(409, { message: 'English text', data: { code } })).alert
    expect(conflict('limit_reached')).toBe('You can have at most 50 calendar links.')
    expect(conflict('calendar_limit_reached')).toBe('A calendar can have at most 50 links.')
    expect(conflict('no_collection')).toBe('The calendar server no longer has this calendar.')
    expect(conflict('busy')).toBe('The server is busy. Try again in a moment.')
    expect(conflict('something_else')).toBe('The link was not created.')
  })

  it('puts the level refusal of a busy-times-only calendar under the level, in words', () => {
    const failure = describeLinkCreateError(
      fetchError(400, {
        data: {
          fields: [
            {
              field: 'level',
              message: 'is more than you can see of this calendar; you see its busy times only',
            },
          ],
        },
      }),
    )
    expect(failure.byField.level).toBe(
      'You see this calendar as busy times only, so a link to it can show busy times only.',
    )
  })
})
