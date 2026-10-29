// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PathRejection,
  resolvePublicPath,
  rewriteDestination,
  type PathRejectionKind,
} from '../../server/utils/gateway/paths'

function rejection(run: () => unknown): PathRejectionKind {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PathRejection)
    return (error as PathRejection).kind
  }
  throw new Error('path was accepted')
}

describe('resolvePublicPath', () => {
  it.each([
    ['/caldav', '/'],
    ['/caldav/', '/'],
    ['/caldav/alice', '/alice'],
    ['/caldav/alice/', '/alice/'],
    ['/caldav/alice/def-calendar/e1.ics', '/alice/def-calendar/e1.ics'],
    ['/caldav/alice/def-calendar/e1.ics?x=1&y=2', '/alice/def-calendar/e1.ics'],
    ['/caldav/alice/?', '/alice/'],
    // Encoded characters are decoded once and written back canonically.
    ['/caldav/a%20b/c%2Bd', '/a%20b/c%2Bd'],
    ['/caldav/a%40b.ics', '/a%40b.ics'],
    ['/caldav/a@b.ics', '/a%40b.ics'],
    ['/caldav/%C3%A4/%e2%82%ac', '/%C3%A4/%E2%82%AC'],
    ['/caldav/a%3Fb%23c', '/a%3Fb%23c'],
    // Double encoding stays encoded: one more decode upstream gives the literal text, not a dot.
    ['/caldav/%252e%252e/x', '/%252e%252e/x'],
    ['/caldav/x/%2e%2e%2e/y', '/x/.../y'],
    ['/caldav/a..b/.hidden.ics', '/a..b/.hidden.ics'],
  ])('reads %j as %j', (target, upstreamPath) => {
    expect(resolvePublicPath(target).upstreamPath).toBe(upstreamPath)
  })

  it('also gives the public form', () => {
    expect(resolvePublicPath('/caldav').publicPath).toBe('/caldav/')
    expect(resolvePublicPath('/caldav/alice/x%20y.ics').publicPath).toBe('/caldav/alice/x%20y.ics')
  })

  it.each([
    // traversal, plain and encoded in every way
    '/caldav/..',
    '/caldav/../etc/passwd',
    '/caldav/a/../b',
    '/caldav/a/..',
    '/caldav/a/%2e%2e/b',
    '/caldav/a/%2E%2E/b',
    '/caldav/a/.%2e/b',
    '/caldav/a/%2e./b',
    '/caldav/%2e%2e',
    '/caldav/a/./b',
    '/caldav/a/.',
    '/caldav/a/%2e/b',
    // separators smuggled in a segment
    '/caldav/a%2Fb',
    '/caldav/a%2fb',
    '/caldav/a%5Cb',
    '/caldav/a%5cb',
    '/caldav/a\\b',
    '/caldav/..\\..\\x',
    '/caldav/a%2F..%2Fb',
    // empty segments
    '/caldav//a',
    '/caldav/a//b',
    '/caldav/a//',
    '/caldav//',
    '/caldav///',
    // control characters, bad encodings
    '/caldav/a%00b',
    '/caldav/a%0d%0ab',
    '/caldav/a%0Ab',
    '/caldav/a%7Fb',
    '/caldav/a%',
    '/caldav/a%2',
    '/caldav/a%zz',
    '/caldav/%ff',
    '/caldav/%c0%af',
    '/caldav/%c0%ae%c0%ae/x',
    // not written as a path
    '/caldav/a b',
    '/caldav/a\tb',
    '/caldav/ä',
    '/caldav/a\nb',
    '/caldav/a#frag',
    '/caldav/a?q#frag',
  ])('refuses %j as malformed', (target) => {
    expect(rejection(() => resolvePublicPath(target))).toBe('malformed')
  })

  it.each([
    'http://evil.example/caldav/a',
    'https://radicale:5232/caldav/a',
    '//evil.example/caldav/a',
    '//caldav/a',
    '*',
    'caldav/a',
    '',
    'radicale:5232',
  ])('refuses the target %j that is not origin-form', (target) => {
    expect(rejection(() => resolvePublicPath(target))).toBe('malformed')
  })

  it.each([
    '/',
    '/caldavx/a',
    '/CalDAV/a',
    '/CALDAV/',
    '/%63aldav/a',
    '/other/caldav/a',
    '/api/config',
    '/.well-known/caldav',
  ])('refuses %j as outside /caldav/', (target) => {
    expect(rejection(() => resolvePublicPath(target))).toBe('outside-prefix')
  })

  it.each([
    '/caldav/.sharing/v1/map/create',
    '/caldav/.sharing',
    '/caldav/.web/',
    '/caldav/.well-known/caldav',
    '/caldav/%2esharing/x',
    '/caldav/.hidden',
    '/caldav/...',
  ])('keeps Radicale’s dot namespace unreachable: %j', (target) => {
    expect(rejection(() => resolvePublicPath(target))).toBe('reserved')
  })

  it('can refuse a query string', () => {
    expect(rejection(() => resolvePublicPath('/caldav/a?x=1', { allowQuery: false }))).toBe(
      'malformed',
    )
    expect(resolvePublicPath('/caldav/a', { allowQuery: false }).upstreamPath).toBe('/a')
  })

  it('leaves nothing that URL would resolve differently', () => {
    // The output goes to fetch(), which parses it as a URL: parsing must not change the path.
    for (const target of ['/caldav/a%20b/%C3%A4/c%2Bd/', '/caldav/%252e%252e/x', '/caldav/a%3Fb']) {
      const { upstreamPath } = resolvePublicPath(target)
      expect(new URL(upstreamPath, 'http://radicale:5232').pathname).toBe(upstreamPath)
    }
  })
})

describe('rewriteDestination', () => {
  it.each([
    ['/caldav/alice/cal/new.ics', '/caldav/alice/cal/new.ics'],
    ['https://calendar.example.org/caldav/alice/cal/new.ics', '/caldav/alice/cal/new.ics'],
    ['http://localhost:3000/caldav/alice/cal/new%20x.ics', '/caldav/alice/cal/new%20x.ics'],
    ['HTTPS://Calendar.Example.org:8443/caldav/alice/', '/caldav/alice/'],
    ['https://host/caldav', '/caldav/'],
    ['https://host/caldav/alice/cal/a@b.ics', '/caldav/alice/cal/a%40b.ics'],
  ])('reduces %j to %j', (value, expected) => {
    expect(rewriteDestination(value)).toBe(expected)
  })

  it.each([
    '/other/alice/x.ics',
    '/',
    '/caldavx/x.ics',
    'https://host/other/x.ics',
    'https://host/',
    'https://caldav/x.ics',
    '/api/config',
  ])('refuses %j as outside /caldav/', (value) => {
    expect(rejection(() => rewriteDestination(value))).toBe('outside-prefix')
  })

  it.each([
    '/caldav/../x.ics',
    '/caldav/alice/%2e%2e/bob/x.ics',
    'https://host/caldav/alice/../../x.ics',
    '/caldav//x.ics',
    '/caldav/alice/x.ics?x=1',
    '/caldav/alice/x.ics#f',
    'https://user@host/caldav/x.ics',
    'https://user:pw@host/caldav/x.ics',
    'https://host\\@evil/caldav/x.ics',
    'ftp://host/caldav/x.ics',
    'file:///caldav/x.ics',
    'javascript://host/caldav/x.ics',
    'https://host',
    'https://host?x=/caldav/x.ics',
    'caldav/x.ics',
    '',
    '//host/caldav/x.ics',
    '/caldav/a%2Fb',
  ])('refuses %j as malformed', (value) => {
    expect(rejection(() => rewriteDestination(value))).toBe('malformed')
  })

  it('refuses a reserved destination', () => {
    expect(rejection(() => rewriteDestination('/caldav/.sharing/x'))).toBe('reserved')
  })
})
