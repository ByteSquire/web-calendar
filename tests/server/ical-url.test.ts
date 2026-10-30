// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_URL_LENGTH, parseSourceUrl } from '../../server/utils/ical-proxy/source-url'
import {
  MAX_SUBSCRIPTION_NAME_LENGTH,
  parseSubscriptionInput,
} from '../../server/utils/ical-proxy/subscription-input'

describe('parseSourceUrl: accepted addresses', () => {
  it.each([
    ['https://example.com/cal.ics', 'https://example.com/cal.ics'],
    ['http://example.com/cal.ics', 'http://example.com/cal.ics'],
    // webcal is only a hint for calendar applications; the file is fetched over https
    ['webcal://example.com/cal.ics', 'https://example.com/cal.ics'],
    ['WEBCAL://Example.COM/Cal.ics?token=A1', 'https://example.com/Cal.ics?token=A1'],
    ['webcal:example.com/cal.ics', 'https://example.com/cal.ics'],
    ['  https://example.com/cal.ics \n', 'https://example.com/cal.ics'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com:443/cal.ics', 'https://example.com/cal.ics'],
    ['http://example.com:8080/cal.ics', 'http://example.com:8080/cal.ics'],
    ['https://example.com/cal.ics#section', 'https://example.com/cal.ics'],
    ['https://example.com/my cal.ics', 'https://example.com/my%20cal.ics'],
    ['https://bücher.example/cal.ics', 'https://xn--bcher-kva.example/cal.ics'],
    ['https://calendar.google.com/calendar/ical/x%40y/private-abc/basic.ics', undefined],
    ['https://93.184.216.34/cal.ics', undefined],
    ['https://[2606:4700:4700::1111]/cal.ics', undefined],
  ])('%s', (raw, expected) => {
    const result = parseSourceUrl(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url.href).toBe(expected ?? raw)
  })

  it('accepts exactly the maximum length and no more', () => {
    const base = 'https://example.com/'
    const exact = base + 'a'.repeat(MAX_URL_LENGTH - base.length)
    expect(parseSourceUrl(exact).ok).toBe(true)
    expect(parseSourceUrl(exact + 'a')).toEqual({
      ok: false,
      error: `must have at most ${MAX_URL_LENGTH} characters`,
    })
  })

  it('counts the normalised address: percent-encoding makes it longer', () => {
    const raw = `https://example.com/${'ü'.repeat(400)}`
    expect(raw.length).toBeLessThan(MAX_URL_LENGTH)
    expect(parseSourceUrl(raw)).toEqual({
      ok: false,
      error: `must have at most ${MAX_URL_LENGTH} characters`,
    })
  })
})

describe('parseSourceUrl: rejected addresses', () => {
  const SCHEME_ERROR = 'must start with http://, https:// or webcal://'

  it.each([
    ['file:///etc/passwd'],
    ['file://localhost/etc/passwd'],
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['ftp://example.com/cal.ics'],
    ['data:text/calendar,BEGIN:VCALENDAR'],
    ['gopher://example.com/'],
    ['ws://example.com/'],
    ['wss://example.com/'],
    ['ssh://example.com/'],
    ['dict://example.com:11211/'],
    ['ldap://example.com/'],
    ['webcals://example.com/cal.ics'],
    ['blob:https://example.com/abc'],
    ['view-source:https://example.com/'],
  ])('refuses the scheme of %s', (raw) => {
    expect(parseSourceUrl(raw)).toEqual({ ok: false, error: SCHEME_ERROR })
  })

  it.each([
    ['http://user:pass@example.com/cal.ics'],
    ['https://user@example.com/cal.ics'],
    ['https://:pass@example.com/cal.ics'],
    ['webcal://user:pass@example.com/cal.ics'],
    ['https://example.com@10.0.0.1/cal.ics'],
    ['https://example.com:80@evil.example/cal.ics'],
  ])('refuses embedded credentials in %s', (raw) => {
    expect(parseSourceUrl(raw)).toEqual({
      ok: false,
      error: 'must not contain a user name or password',
    })
  })

  it.each([
    [''],
    ['   '],
    ['example.com/cal.ics'],
    ['//example.com/cal.ics'],
    ['/cal.ics'],
    ['https://'],
    ['http://exa mple.com/'],
    ['http://exa<mple.com/'],
    ['http://[::1/'],
    ['http://999.999.999.999/'],
    ['http://example.com:99999/'],
    ['not a url'],
  ])('refuses the malformed address "%s"', (raw) => {
    const result = parseSourceUrl(raw)
    expect(result.ok).toBe(false)
  })

  it('refuses a host name that is too long', () => {
    const label = 'a'.repeat(63)
    const host = [label, label, label, label, 'com'].join('.')
    expect(host.length).toBeGreaterThan(253)
    expect(parseSourceUrl(`https://${host}/`).ok).toBe(false)
  })

  it('refuses an address over the length limit before parsing it', () => {
    const result = parseSourceUrl(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`)
    expect(result).toEqual({
      ok: false,
      error: `must have at most ${MAX_URL_LENGTH} characters`,
    })
  })
})

describe('parseSubscriptionInput', () => {
  const valid = { name: 'Holidays', url: 'https://example.com/holidays.ics', color: '#1a2b3c' }

  function fieldsOf(body: unknown): string[] {
    const result = parseSubscriptionInput(body)
    return result.ok ? [] : result.fields.map((entry) => entry.field)
  }

  // Reading a field of a non-object body would only repeat the one real problem.
  const NOT_AN_OBJECT: [string, unknown][] = [
    ['null', null],
    ['a list', [valid]],
    ['a string', 'name=a'],
    ['nothing', undefined],
  ]

  it.each(NOT_AN_OBJECT)('rejects %s as a body', (_label, body) => {
    expect(fieldsOf(body)).toContain('body')
  })

  it('returns the normalised values', () => {
    expect(parseSubscriptionInput(valid)).toEqual({ ok: true, value: valid })
    expect(
      parseSubscriptionInput({
        name: '  Holidays ',
        url: 'webcal://Example.com/holidays.ics#x',
        color: '#ABCDEF',
      }),
    ).toEqual({
      ok: true,
      value: { name: 'Holidays', url: 'https://example.com/holidays.ics', color: '#abcdef' },
    })
  })

  it('takes a missing or null color as no color', () => {
    expect(parseSubscriptionInput({ name: 'A', url: valid.url })).toMatchObject({
      ok: true,
      value: { color: null },
    })
    expect(parseSubscriptionInput({ name: 'A', url: valid.url, color: null })).toMatchObject({
      ok: true,
      value: { color: null },
    })
  })

  it('ignores unknown fields', () => {
    expect(parseSubscriptionInput({ ...valid, owner_id: 7, shared: true, id: 3 })).toEqual({
      ok: true,
      value: valid,
    })
  })

  it('accepts a name of exactly the maximum length', () => {
    const name = 'n'.repeat(MAX_SUBSCRIPTION_NAME_LENGTH)
    expect(parseSubscriptionInput({ ...valid, name })).toMatchObject({ ok: true })
  })

  it.each([
    ['no name', { url: valid.url }, ['name']],
    ['an empty name', { ...valid, name: '' }, ['name']],
    ['a blank name', { ...valid, name: '   ' }, ['name']],
    ['a name that is not a string', { ...valid, name: 7 }, ['name']],
    [
      'a name over the limit',
      { ...valid, name: 'n'.repeat(MAX_SUBSCRIPTION_NAME_LENGTH + 1) },
      ['name'],
    ],
    ['no url', { name: 'A' }, ['url']],
    ['a null url', { name: 'A', url: null }, ['url']],
    ['a url that is not a string', { name: 'A', url: 5 }, ['url']],
    ['a file url', { ...valid, url: 'file:///etc/passwd' }, ['url']],
    ['a url with credentials', { ...valid, url: 'https://u:p@example.com/a.ics' }, ['url']],
    ['a color without the hash', { ...valid, color: '1a2b3c' }, ['color']],
    ['a short color', { ...valid, color: '#fff' }, ['color']],
    ['a color name', { ...valid, color: 'red' }, ['color']],
    ['a color with a bad digit', { ...valid, color: '#12345g' }, ['color']],
    ['an empty color', { ...valid, color: '' }, ['color']],
    ['a color that is not a string', { ...valid, color: 123456 }, ['color']],
    [
      'everything wrong at once',
      { name: '', url: 'ftp://x', color: 'x' },
      ['name', 'color', 'url'],
    ],
  ])('rejects %s', (_label, body, fields) => {
    expect(fieldsOf(body).sort()).toEqual([...fields].sort())
  })
})
