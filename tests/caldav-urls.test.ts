// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DavError, errorFromThrown, kindForStatus } from '../app/utils/caldav/errors'
import {
  ensureTrailingSlash,
  hrefForCaller,
  normalizeColor,
  normalizeEtag,
  parseBaseUrl,
  requireEtag,
  resolveRequestUrl,
  resourceKey,
  toDavPath,
  xmlEscape,
} from '../app/utils/caldav/urls'
import { isWellFormedXml } from '../app/utils/caldav/xml'

describe('normalizeEtag', () => {
  it.each([
    ['"abc"', '"abc"'],
    ['W/"abc"', '"abc"'],
    ['w/"abc"', '"abc"'],
    ['  "abc"  ', '"abc"'],
    ['abc', '"abc"'],
    ['W/abc', '"abc"'],
    ['"a b"', '"a b"'],
  ])('reads %j as %j', (given, expected) => {
    expect(normalizeEtag(given)).toBe(expected)
  })

  it.each([[''], ['   '], ['""'], ['W/'], ['"a"\r\nX: y'], ['"a\u0000"'], [null], [undefined]])(
    'reads %j as no tag',
    (given) => {
      expect(normalizeEtag(given)).toBeNull()
    },
  )

  it('is stable: the weak and the strong spelling are the same tag', () => {
    expect(normalizeEtag('W/"x"')).toBe(normalizeEtag('"x"'))
    expect(normalizeEtag(normalizeEtag('W/"x"'))).toBe('"x"')
  })

  it('requireEtag refuses what normalizeEtag drops', () => {
    expect(requireEtag('W/"x"')).toBe('"x"')
    expect(() => requireEtag('')).toThrow(TypeError)
  })
})

describe('normalizeColor', () => {
  it.each([
    ['#FF5733', '#ff5733'],
    ['#ff573380', '#ff5733'],
    ['#abc', '#aabbcc'],
    [' #ABCDEF ', '#abcdef'],
  ])('reads %j as %j', (given, expected) => {
    expect(normalizeColor(given)).toBe(expected)
  })

  it.each([
    ['red'],
    [''],
    ['#12'],
    ['#12345'],
    ['#1234567'],
    ['#ggg'],
    ['#fff; x:y'],
    ['url(x)'],
    [3],
    [null],
  ])('reads %j as no colour', (given) => {
    expect(normalizeColor(given)).toBeNull()
  })
})

describe('resolveRequestUrl', () => {
  const base = parseBaseUrl('http://dav.test/caldav')

  it('adds the trailing slash to the base', () => {
    expect(base.href).toBe('http://dav.test/caldav/')
  })

  it.each([
    ['/caldav/u/cal/', 'http://dav.test/caldav/u/cal/'],
    ['http://dav.test/caldav/u/cal/a.ics', 'http://dav.test/caldav/u/cal/a.ics'],
    ['/caldav/u/shared%20team/', 'http://dav.test/caldav/u/shared%20team/'],
    ['/caldav/u/cal/#frag', 'http://dav.test/caldav/u/cal/'],
    ['http://DAV.test:80/caldav/x/', 'http://dav.test/caldav/x/'],
  ])('resolves %j', (href, expected) => {
    expect(resolveRequestUrl(href, base)).toBe(expected)
  })

  it('resolves a relative reference against the request it came from', () => {
    expect(resolveRequestUrl('a.ics', base, 'http://dav.test/caldav/u/cal/')).toBe(
      'http://dav.test/caldav/u/cal/a.ics',
    )
  })

  it.each([
    ['http://evil.test/caldav/'],
    ['//evil.test/caldav/'],
    ['http://dav.test.evil.test/'],
    ['http://dav.test@evil.test/'],
    ['http://dav.test:81/caldav/'],
    ['https://dav.test/caldav/'],
    ['http://u:p@dav.test/caldav/'],
    ['http://:p@dav.test/caldav/'],
    ['javascript:alert(1)'],
    ['data:text/plain,x'],
    ['blob:http://dav.test/1'],
    ['file:///etc/passwd'],
    ['ws://dav.test/caldav/'],
    ['http://[::1'],
  ])('refuses %j', (href) => {
    const attempt = () => resolveRequestUrl(href, base)
    expect(attempt).toThrow(DavError)
    try {
      attempt()
    } catch (error) {
      expect((error as DavError).kind).toBe('bad-response')
    }
  })
})

describe('parseBaseUrl', () => {
  it.each([['not a url'], ['ftp://dav.test/'], ['/caldav'], ['']])('refuses %j', (given) => {
    expect(() => parseBaseUrl(given)).toThrow(TypeError)
  })

  it('drops a query and a fragment', () => {
    expect(parseBaseUrl('https://dav.test/caldav?x=1#y').href).toBe('https://dav.test/caldav/')
  })
})

describe('href helpers', () => {
  it('toDavPath keeps paths and reduces absolute URLs to path and query', () => {
    expect(toDavPath('/caldav/u/')).toBe('/caldav/u/')
    expect(toDavPath('http://dav.test/caldav/u/?x=1')).toBe('/caldav/u/?x=1')
    expect(toDavPath('relative/x')).toBe('relative/x')
  })

  it('hrefForCaller keeps the server’s form and resolves relative references', () => {
    const request = 'http://dav.test/caldav/u/'
    expect(hrefForCaller(' /caldav/u/c/ ', request)).toBe('/caldav/u/c/')
    expect(hrefForCaller('http://dav.test/caldav/u/c/', request)).toBe(
      'http://dav.test/caldav/u/c/',
    )
    expect(hrefForCaller('c/a.ics', request)).toBe('/caldav/u/c/a.ics')
  })

  it('ensureTrailingSlash leaves queries alone', () => {
    expect(ensureTrailingSlash('/a')).toBe('/a/')
    expect(ensureTrailingSlash('/a/')).toBe('/a/')
    expect(ensureTrailingSlash('/a?x=1')).toBe('/a/?x=1')
  })

  it('resourceKey makes spellings of one resource equal', () => {
    const keys = [
      '/caldav/u/shared%20team/',
      '/caldav/u/shared%20team',
      'http://dav.test/caldav/u/shared%20team/',
      '/caldav/u/shared team/',
      '/caldav/u/shared%20team/?x=1',
    ].map(resourceKey)
    expect(new Set(keys).size).toBe(1)
    expect(resourceKey('/caldav/u/a%2fb/')).not.toBe(resourceKey('/caldav/u/a/b/'))
    expect(resourceKey('/')).toBe('/')
  })

  it('xmlEscape covers everything that can break out of text or an attribute', () => {
    expect(xmlEscape(`<a href="x" b='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; b=&apos;y&apos;&gt;&amp;&lt;/a&gt;',
    )
  })
})

describe('errors', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [410, 'not-found'],
    [409, 'conflict'],
    [412, 'conflict'],
    [408, 'unavailable'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
    [400, 'rejected'],
    [405, 'rejected'],
    [413, 'rejected'],
    [415, 'rejected'],
    [300, 'bad-response'],
    [200, 'bad-response'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(kindForStatus(status)).toBe(kind)
  })

  it('classifies what a fetch throws', () => {
    const abort = new DOMException('x', 'AbortError')
    expect(errorFromThrown(abort).kind).toBe('aborted')
    expect(errorFromThrown(new TypeError('Failed to fetch')).kind).toBe('network')
    expect(errorFromThrown(new DOMException('x', 'TimeoutError')).kind).toBe('network')
    expect(errorFromThrown('weird').kind).toBe('network')
    const existing = new DavError('unauthorized', 'again')
    expect(errorFromThrown(existing)).toBe(existing)
    const controller = new AbortController()
    controller.abort()
    expect(errorFromThrown(new Error('whatever'), controller.signal).kind).toBe('aborted')
    const timeout = AbortSignal.timeout(1)
    return new Promise<void>((resolve) =>
      timeout.addEventListener('abort', () => {
        expect(errorFromThrown(new Error('x'), timeout).kind).toBe('network')
        resolve()
      }),
    )
  })
})

describe('isWellFormedXml', () => {
  it.each([
    ['<a/>'],
    ["<?xml version='1.0' encoding='utf-8'?>\n<multistatus xmlns=\"DAV:\" />"],
    ['<a><b x="1 > 0">t &amp; u</b><c/><!-- <not a tag> --></a>\n'],
    ['<a><![CDATA[ <b> & ]]></a>'],
    ['<D:multistatus xmlns:D="DAV:"><D:response></D:response></D:multistatus>'],
    ["<a b='>'></a>"],
    ['<a b="1"/>'],
    ['<a  b = "1"  />'],
    ['<a>\n</a  >'],
    ['<a\n b="1"\n>x</a>'],
  ])('accepts %j', (text) => {
    expect(isWellFormedXml(text)).toBe(true)
  })

  it.each([
    [''],
    ['not xml'],
    ['<a>'],
    ['<a><b></a></b>'],
    ['<a></b>'],
    ['<a><b>'],
    ['<a>text'],
    ['<a/><b/>'],
    ['<a></a>trailing'],
    ['leading<a/>'],
    ['<a>1 < 2</a>'],
    ['<a b="x></a>'],
    ['</a>'],
    ['<multistatus xmlns="DAV:"><response><href>'],
    ['<a><!-- unterminated </a>'],
  ])('rejects %j', (text) => {
    expect(isWellFormedXml(text)).toBe(false)
  })

  it('handles a large document in linear time', () => {
    const big = `<a>${'<b x="1">text</b>'.repeat(50_000)}<![CDATA[${'x'.repeat(1_000_000)}]]></a>`
    const started = performance.now()
    expect(isWellFormedXml(big)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  // Every answer is checked, so hostile input must not make the check slow (a frozen page).
  it.each([
    ['letters after <', `<${'a'.repeat(100_000)}`],
    ['letters after </', `</${'a'.repeat(100_000)}`],
    ['spaces after a name', `<a${' '.repeat(100_000)}`],
    ['quotes in attributes', `<a x=${'"'.repeat(100_000)}`],
    ['paired quotes without an end', `<a ${'"b" '.repeat(30_000)}`],
    ['an unterminated quote', `<a x="${'y'.repeat(100_000)}`],
    ['slashes', `<a${'/'.repeat(100_000)}`],
    ['an unterminated comment', `<a><!--${'-'.repeat(100_000)}`],
    ['an unterminated CDATA', `<a><![CDATA[${']'.repeat(100_000)}`],
    ['nesting', '<a>'.repeat(100_000)],
    ['opening angle brackets', '<'.repeat(100_000)],
  ])('rejects %s quickly', (_name, text) => {
    const started = performance.now()
    expect(isWellFormedXml(text)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
