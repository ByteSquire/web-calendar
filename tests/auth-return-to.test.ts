// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { safeReturnTo } from '../app/utils/auth/return-to'

describe('safeReturnTo: what is kept', () => {
  it.each([
    ['/', '/'],
    ['/calendar', '/calendar'],
    ['/calendar?view=week&date=2026-10-30', '/calendar?view=week&date=2026-10-30'],
    ['/calendar#event-1', '/calendar#event-1'],
    ['/a/b/c?x=1#y', '/a/b/c?x=1#y'],
    // The URL parser normalises dot segments and encoding.
    ['/a/../b', '/b'],
    ['/a b', '/a%20b'],
    // An encoded slash or backslash is data, not a separator.
    ['/%2F%2Fevil.com', '/%2F%2Fevil.com'],
    ['/%5Cevil.com', '/%5Cevil.com'],
    // Looks like a scheme but is a path segment.
    ['/https://evil.com', '/https://evil.com'],
  ])('%j -> %j', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected)
  })
})

describe('safeReturnTo: what is rejected', () => {
  it.each([
    // absolute and network-path references
    ['https://evil.com'],
    ['http://evil.com/path'],
    ['//evil.com'],
    ['///evil.com'],
    ['//evil.com/path'],
    // other schemes
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['mailto:a@b.c'],
    // backslashes are read as slashes by browsers
    ['/\\evil.com'],
    ['\\\\evil.com'],
    ['\\evil.com'],
    ['/path\\..\\evil'],
    ['https:\\\\evil.com'],
    // control characters are dropped by URL parsers: "/\t/evil.com" would become "//evil.com"
    ['/\t/evil.com'],
    ['/\n/evil.com'],
    ['/\r/evil.com'],
    ['/\u0000/evil.com'],
    ['\t//evil.com'],
    [' //evil.com'],
    [' /ok'],
    // dot segments that collapse into a network-path reference
    ['/.//evil.com'],
    ['/a/..//evil.com'],
    ['/./\\evil.com'],
    // not a path at all
    [''],
    ['evil.com'],
    ['calendar'],
    ['?x=1'],
    ['#x'],
    // the login's own pages: a loop
    ['/auth/callback'],
    ['/auth/callback?code=1&state=2'],
    ['/auth/callback/'],
    ['/auth/signed-out'],
    ['/auth'],
    ['/auth/'],
  ])('%j -> /', (input) => {
    expect(safeReturnTo(input)).toBe('/')
  })

  it.each([[undefined], [null], [42], [{}], [['/ok']], [true]])(
    '%j (not a string) -> /',
    (input) => {
      expect(safeReturnTo(input)).toBe('/')
    },
  )

  it('does not mistake other paths for the login pages', () => {
    expect(safeReturnTo('/authors')).toBe('/authors')
    expect(safeReturnTo('/x/auth/callback')).toBe('/x/auth/callback')
  })

  it('uses the given fallback', () => {
    expect(safeReturnTo('//evil.com', '/home')).toBe('/home')
    expect(safeReturnTo('/ok', '/home')).toBe('/ok')
  })
})
