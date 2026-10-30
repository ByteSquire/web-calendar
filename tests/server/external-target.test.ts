// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_TARGET_PART_LENGTH, parseProxyTarget } from '../../server/utils/external/target'

// The text after `/api/external/<id>`: a path (and query) on the account's origin and nothing that
// could name another place. The origin itself never comes from here.

function accepted(rest: string) {
  const parsed = parseProxyTarget(rest)
  if (!parsed.ok)
    throw new Error(`expected ${JSON.stringify(rest)} to be accepted: ${parsed.reason}`)
  return parsed
}

describe('accepted targets', () => {
  it.each([
    ['/', '/', ''],
    ['/dav/', '/dav/', ''],
    ['/dav/calendars/alice/work/', '/dav/calendars/alice/work/', ''],
    ['/dav/calendars/alice/work/standup.ics', '/dav/calendars/alice/work/standup.ics', ''],
    ['/a?x=1&y=%2F', '/a', '?x=1&y=%2F'],
    ['/a?', '/a', '?'],
    ['/?export', '/', '?export'],
    ['/principals/user@example.org/', '/principals/user@example.org/', ''],
    ['/principals/user%40example.org/', '/principals/user%40example.org/', ''],
    ['/a%20b/%C3%A4.ics', '/a%20b/%C3%A4.ics', ''],
    ['/a:b;c=d,e/(f)/$g/!h/*i/~j/', '/a:b;c=d,e/(f)/$g/!h/*i/~j/', ''],
    ['/100%25/', '/100%25/', ''],
    ['/.well-known/caldav', '/.well-known/caldav', ''],
    ['/.hidden/..dots/dots../a.b.c', '/.hidden/..dots/dots../a.b.c', ''],
    ['/a?next=//evil.example/x', '/a', '?next=//evil.example/x'],
  ])('%j', (rest, path, query) => {
    expect(accepted(rest)).toEqual({ ok: true, path, query })
  })

  it('forwards the text as written: nothing is re-encoded or normalised', () => {
    expect(accepted('/p/user@example.org:8080/%7euser/').path).toBe(
      '/p/user@example.org:8080/%7euser/',
    )
    expect(parseProxyTarget('/a%2fb/').ok).toBe(false)
  })

  it('accepts the longest allowed path and query', () => {
    const path = `/${'a'.repeat(MAX_TARGET_PART_LENGTH - 1)}`
    expect(accepted(path).path).toHaveLength(MAX_TARGET_PART_LENGTH)
    const query = `?${'q'.repeat(MAX_TARGET_PART_LENGTH - 1)}`
    expect(accepted(`/${query}`).query).toHaveLength(MAX_TARGET_PART_LENGTH)
  })
})

const REJECTED: [name: string, rest: string][] = [
  // Not a path on the origin
  ['an empty target', ''],
  ['a query without a path', '?x=1'],
  ['no leading slash', 'dav/'],
  ['a relative path', '../dav/'],
  ['an absolute URL', 'https://evil.example/'],
  ['a scheme-relative URL', '//evil.example/dav/'],
  ['two slashes at the start with a path', '//dav/calendars/'],
  ['three slashes', '///'],
  ['an empty segment in the middle', '/dav//calendars/'],
  ['an empty segment before the last', '/a//'],
  ['an authority-looking start', '@evil.example/'],
  ['a star', '*'],
  // Dot segments in every spelling
  ['..', '/..'],
  ['../ at the end', '/dav/../'],
  ['../ in the middle', '/dav/../admin/'],
  ['a leading ../', '/../etc/passwd'],
  ['a single dot', '/dav/./calendars/'],
  ['a trailing dot segment', '/dav/.'],
  ['an encoded dot pair, lower case', '/dav/%2e%2e/admin'],
  ['an encoded dot pair, upper case', '/dav/%2E%2E/admin'],
  ['a half-encoded dot pair', '/dav/.%2e/admin'],
  ['another half-encoded dot pair', '/dav/%2e./admin'],
  ['an encoded single dot', '/dav/%2e/x'],
  ['a double-encoded dot pair', '/dav/%252e%252e/admin'],
  ['a double-encoded slash', '/dav/a%252fb'],
  ['a double-encoded backslash', '/dav/a%255cb'],
  ['dots with a parameter', '/dav/..;x=1/admin'],
  ['dot with a parameter', '/dav/.;/admin'],
  ['dots with an encoded semicolon', '/dav/..%3Bx/admin'],
  // Separators smuggled in
  ['an encoded slash', '/dav/a%2fb'],
  ['an encoded slash, upper case', '/dav/a%2Fb'],
  ['only an encoded slash', '/%2f'],
  ['an encoded backslash', '/dav/a%5cb'],
  ['an encoded backslash, upper case', '/dav/a%5Cb'],
  ['a backslash', '/dav\\calendars/'],
  ['a backslash dot pair', '/dav/..\\admin'],
  ['a leading backslash', '\\\\evil.example\\share'],
  ['a slash backslash start', '/\\evil.example/'],
  // Control characters and bytes that must be encoded
  ['an encoded NUL', '/dav/%00'],
  ['an encoded newline', '/dav/a%0ab'],
  ['an encoded carriage return', '/dav/a%0Db'],
  ['an encoded tab', '/dav/a%09b'],
  ['an encoded DEL', '/dav/a%7fb'],
  ['an encoded C1 control', '/dav/a%C2%85b'],
  ['a raw newline', '/dav/a\nb'],
  ['a raw carriage return', '/dav/a\rb'],
  ['a raw NUL', '/dav/a\0b'],
  ['a raw tab', '/dav/a\tb'],
  ['a raw space', '/dav/a b'],
  ['a raw non-ASCII character', '/dav/ä'],
  ['a raw emoji', '/dav/😀'],
  ['a CRLF header injection in the path', '/dav/ HTTP/1.1\r\nHost: evil.example\r\n\r\n'],
  ['a CRLF header injection in the query', '/dav/?a=b\r\nHost: evil.example'],
  ['a raw space in the query', '/dav/?a=b c'],
  ['a raw non-ASCII character in the query', '/dav/?a=ä'],
  ['an encoded control character in the query', '/dav/?a=%00'],
  ['an encoded newline in the query', '/dav/?a=%0d%0aHost:evil'],
  ['a backslash in the query', '/dav/?a=\\b'],
  // Broken encoding
  ['a lone percent', '/dav/%'],
  ['a percent and one digit', '/dav/%2'],
  ['a percent and non-hex', '/dav/%zz'],
  ['invalid UTF-8', '/dav/%C3%28'],
  ['an overlong UTF-8 slash', '/dav/%C0%AF'],
  ['a lone surrogate', '/dav/%ED%A0%80'],
  ['a bad escape in the query', '/dav/?a=%zz'],
  // Fragments
  ['a fragment', '/dav/#frag'],
  ['a fragment after a query', '/dav/?a=b#frag'],
  // Length
  ['an over-long path', `/${'a'.repeat(MAX_TARGET_PART_LENGTH)}`],
  ['an over-long query', `/?${'q'.repeat(MAX_TARGET_PART_LENGTH)}`],
]

describe('rejected targets', () => {
  it.each(REJECTED)('%s', (_name, rest) => {
    const parsed = parseProxyTarget(rest)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.reason).toMatch(/\S/)
      // The reason never repeats the target: it goes to a log that must not hold paths.
      expect(parsed.reason).not.toContain('admin')
      expect(parsed.reason).not.toContain('evil')
    }
  })
})
