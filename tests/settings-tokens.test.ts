// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  activeTokens,
  caldavAddress,
  caldavDiscoveryAddress,
  tokenLimit,
} from '../app/utils/settings/tokens'
import type { TokenListItem } from '../app/utils/settings/types'

const token = (id: number, expired = false): TokenListItem => ({
  id,
  label: `token ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2027-01-01T00:00:00.000Z',
  lastUsedAt: null,
  expired,
})

describe('addresses', () => {
  it.each([
    ['https://calendar.example.org', 'https://calendar.example.org/caldav/'],
    ['https://calendar.example.org/', 'https://calendar.example.org/caldav/'],
    ['http://127.0.0.1:3300', 'http://127.0.0.1:3300/caldav/'],
  ])('%s -> %s', (origin, expected) => {
    expect(caldavAddress(origin)).toBe(expected)
  })

  it('has the discovery address next to it', () => {
    expect(caldavDiscoveryAddress('https://calendar.example.org')).toBe(
      'https://calendar.example.org/.well-known/caldav',
    )
  })
})

describe('tokenLimit', () => {
  const tokens = (count: number, expired = 0) => [
    ...Array.from({ length: count }, (_, index) => token(index + 1)),
    ...Array.from({ length: expired }, (_, index) => token(100 + index, true)),
  ]

  it('is not reached below the limit', () => {
    const result = tokenLimit({ tokens: tokens(9), limit: 10 })
    expect(result).toMatchObject({ used: 9, limit: 10, reached: false })
    expect(result.message).toBe('9 of 10 app tokens in use. Expired tokens do not count.')
  })

  it('is reached at the limit and says what to do', () => {
    const result = tokenLimit({ tokens: tokens(10), limit: 10 })
    expect(result.reached).toBe(true)
    expect(result.message).toMatch(/Revoke a token to create another/)
  })

  it('does not count expired tokens, as the server does', () => {
    // 10 rows, but only 9 count: creating is still possible
    expect(tokenLimit({ tokens: tokens(9, 1), limit: 10 }).reached).toBe(false)
    expect(tokenLimit({ tokens: tokens(0, 12), limit: 10 })).toMatchObject({
      used: 0,
      reached: false,
    })
  })

  it('uses the limit of the server', () => {
    expect(tokenLimit({ tokens: tokens(3), limit: 3 }).reached).toBe(true)
  })

  it('is open before the list is loaded: the server enforces the limit anyway', () => {
    expect(tokenLimit(null)).toMatchObject({ reached: false, message: '' })
  })
})

describe('activeTokens', () => {
  it('trusts the flag of the server, not the date', () => {
    const items = [token(1), token(2, true)]
    // expiresAt of both lies in the future relative to 2026 text; only `expired` decides
    expect(activeTokens(items).map((item) => item.id)).toEqual([1])
  })
})
