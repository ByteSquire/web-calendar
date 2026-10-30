// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ApiError, found, notFound, toBadRequest } from '../../server/utils/api/errors'
import {
  expectValid,
  FieldErrors,
  finish,
  isRecord,
  MAX_REF_LENGTH,
  parseId,
  readObject,
  readCalendarRef,
  readChoice,
  readColor,
  readOptionalBoolean,
  readOptionalColor,
  readText,
} from '../../server/utils/api/validation'

/** Runs one reader and returns what it gave back plus the field errors it collected. */
function read<T>(reader: (errors: FieldErrors) => T): { value: T; errors: string[] } {
  const errors = new FieldErrors()
  const value = reader(errors)
  return { value, errors: errors.toArray().map((e) => e.field) }
}

describe('readText', () => {
  it.each([
    ['Team', 'Team'],
    ['  padded  ', 'padded'],
    ['x'.repeat(10), 'x'.repeat(10)],
    ['ünïcode ✓', 'ünïcode ✓'],
  ])('accepts %j', (input, expected) => {
    expect(read((e) => readText(input, 'name', 10, e))).toEqual({ value: expected, errors: [] })
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', ' \t\n '],
    ['a number', 5],
    ['a boolean', true],
    ['a list', ['a']],
    ['an object', { toString: 'x' }],
    ['too long', 'x'.repeat(11)],
    ['too long after trimming', ` ${'x'.repeat(11)} `],
    ['a megabyte', 'x'.repeat(1_000_000)],
  ])('rejects %s', (_label, input) => {
    expect(read((e) => readText(input, 'name', 10, e))).toEqual({
      value: undefined,
      errors: ['name'],
    })
  })

  it('counts the limit after trimming', () => {
    expect(read((e) => readText(`  ${'x'.repeat(10)}  `, 'name', 10, e)).errors).toEqual([])
  })
})

describe('readColor and readOptionalColor', () => {
  it.each([
    ['#aabbcc', '#aabbcc'],
    ['#AABBCC', '#aabbcc'],
    ['#0a1B2c', '#0a1b2c'],
  ])('stores %s as %s', (input, expected) => {
    expect(read((e) => readColor(input, 'color', e))).toEqual({ value: expected, errors: [] })
  })

  it.each([
    'red',
    '#abc',
    '#aabbccdd',
    'aabbcc',
    '#gggggg',
    '# aabbc',
    '#aabbcc ',
    ' #aabbcc',
    '#aabbcc\n',
    '',
    5,
    {},
    [],
    true,
  ])('rejects %j', (input) => {
    expect(read((e) => readColor(input, 'color', e))).toEqual({
      value: undefined,
      errors: ['color'],
    })
  })

  it('keeps omitted and null apart for the optional reader', () => {
    expect(read((e) => readOptionalColor(undefined, 'c', e))).toEqual({
      value: undefined,
      errors: [],
    })
    expect(read((e) => readOptionalColor(null, 'c', e))).toEqual({ value: null, errors: [] })
    expect(read((e) => readOptionalColor('#ABCDEF', 'c', e))).toEqual({
      value: '#abcdef',
      errors: [],
    })
    expect(read((e) => readOptionalColor('nope', 'c', e)).errors).toEqual(['c'])
  })
})

describe('readCalendarRef', () => {
  it.each([
    'dav:/caldav/189c6a24-f9cb-437b-8f58-b5cc8d7f909e/3f2a/',
    'ics:12',
    'ext:acc-1:https://cal.example.org/dav/work/',
    'dav:x',
    `dav:${'x'.repeat(MAX_REF_LENGTH - 4)}`,
    'ics:with spaces and ünïcode',
  ])('accepts %j', (ref) => {
    expect(read((e) => readCalendarRef(ref, 'ref', e))).toEqual({ value: ref, errors: [] })
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 12],
    ['a list', ['dav:/x/']],
    ['empty', ''],
    ['no prefix', '/caldav/x/'],
    ['only the prefix', 'dav:'],
    ['only the prefix (ics)', 'ics:'],
    ['only the prefix (ext)', 'ext:'],
    ['an unknown prefix', 'http:/x'],
    ['an uppercase prefix', 'DAV:/x'],
    ['a prefix after a blank', ' dav:/x'],
    ['no colon', 'dav/x'],
    ['too long', `dav:${'x'.repeat(MAX_REF_LENGTH - 3)}`],
    ['a huge string', `ics:${'x'.repeat(1_000_000)}`],
    ['a newline', 'dav:/x\n/y'],
    ['a NUL byte', 'ics:1\u0000'],
    ['a tab', 'ext:a:\thttps://x'],
    ['DEL', 'dav:/x\u007f'],
  ])('rejects %s', (_label, ref) => {
    expect(read((e) => readCalendarRef(ref, 'ref', e))).toEqual({
      value: undefined,
      errors: ['ref'],
    })
  })

  it('allows exactly the maximum length', () => {
    const ref = `dav:${'x'.repeat(MAX_REF_LENGTH - 4)}`
    expect(ref).toHaveLength(MAX_REF_LENGTH)
    expect(read((e) => readCalendarRef(ref, 'ref', e)).errors).toEqual([])
  })
})

describe('readChoice', () => {
  const allowed = ['a', 'b'] as const

  it('accepts a listed value', () => {
    expect(read((e) => readChoice('b', 'kind', allowed, e))).toEqual({ value: 'b', errors: [] })
  })

  it.each([['c'], ['A'], [' a'], [''], [1], [['a']], [{}]])('rejects %j', (input) => {
    expect(read((e) => readChoice(input, 'kind', allowed, e))).toEqual({
      value: undefined,
      errors: ['kind'],
    })
  })

  it('needs a value unless there is a fallback, which also covers null', () => {
    expect(read((e) => readChoice(undefined, 'kind', allowed, e)).errors).toEqual(['kind'])
    expect(read((e) => readChoice(null, 'kind', allowed, e)).errors).toEqual(['kind'])
    expect(read((e) => readChoice(undefined, 'kind', allowed, e, 'a')).value).toBe('a')
    expect(read((e) => readChoice(null, 'kind', allowed, e, 'a')).value).toBe('a')
    expect(read((e) => readChoice('zzz', 'kind', allowed, e, 'a')).errors).toEqual(['kind'])
  })
})

describe('readOptionalBoolean', () => {
  it('passes booleans and undefined, rejects everything else', () => {
    expect(read((e) => readOptionalBoolean(true, 'v', e))).toEqual({ value: true, errors: [] })
    expect(read((e) => readOptionalBoolean(false, 'v', e))).toEqual({ value: false, errors: [] })
    expect(read((e) => readOptionalBoolean(undefined, 'v', e))).toEqual({
      value: undefined,
      errors: [],
    })
    for (const bad of [null, 0, 1, 'true', 'false', [], {}]) {
      expect(read((e) => readOptionalBoolean(bad, 'v', e)).errors).toEqual(['v'])
    }
  })
})

describe('readObject and isRecord', () => {
  it('accepts an object and ignores what it holds', () => {
    const body = { name: 'x', extra: [1, 2] }
    expect(read((e) => readObject(body, e))).toEqual({ value: body, errors: [] })
    expect(isRecord(Object.create(null))).toBe(true)
  })

  it.each([
    ['no body', undefined],
    ['null', null],
    ['a list', []],
    ['a string', 'name=x'],
    ['a number', 7],
    ['a boolean', false],
  ])('rejects %s with one error on body', (_label, body) => {
    expect(read((e) => readObject(body, e))).toEqual({ value: {}, errors: ['body'] })
  })
})

describe('FieldErrors', () => {
  it('collects errors, keeps their order and caps how many it reports', () => {
    const errors = new FieldErrors()
    expect(errors.ok).toBe(true)
    for (let i = 0; i < 500; i += 1) errors.add(`f${i}`, 'bad')
    expect(errors.ok).toBe(false)
    expect(errors.toArray()).toHaveLength(20)
    expect(errors.toArray()[0]).toEqual({ field: 'f0', message: 'bad' })
    expect(errors.toArray()[19]!.field).toBe('f19')
  })

  it('hands out a copy', () => {
    const errors = new FieldErrors()
    errors.add('a', 'bad')
    errors.toArray().pop()
    expect(errors.toArray()).toHaveLength(1)
  })
})

describe('finish and expectValid', () => {
  it('builds the value only when there are no errors', () => {
    const good = new FieldErrors()
    expect(finish(good, () => 5)).toEqual({ ok: true, value: 5 })

    const bad = new FieldErrors()
    bad.add('x', 'wrong')
    let built = false
    expect(
      finish(bad, () => {
        built = true
      }),
    ).toEqual({ ok: false, fields: [{ field: 'x', message: 'wrong' }] })
    expect(built).toBe(false)
  })

  it('expectValid returns the value or throws the 400', () => {
    expect(expectValid({ ok: true, value: 'v' })).toBe('v')
    const failure = () => expectValid({ ok: false, fields: [{ field: 'x', message: 'wrong' }] })
    expect(failure).toThrow(ApiError)
    expect(failure).toThrow(
      expect.objectContaining({
        statusCode: 400,
        data: { fields: [{ field: 'x', message: 'wrong' }] },
      }),
    )
  })
})

describe('parseId', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    ['999999999999999', 999_999_999_999_999],
  ])('reads %s', (raw, id) => {
    expect(parseId(raw)).toBe(id)
  })

  it.each([
    undefined,
    null,
    '',
    '0',
    '01',
    '-1',
    '1.5',
    '1e3',
    ' 1',
    '1 ',
    '0x10',
    'abc',
    '1;DROP TABLE views',
    '9999999999999999',
    '99999999999999999999',
    ['1'],
    1,
  ])('answers 404 for %j', (raw) => {
    expect(() => parseId(raw)).toThrow(
      expect.objectContaining({ name: 'ApiError', statusCode: 404 }),
    )
  })
})

describe('error helpers', () => {
  it('build the three API errors', () => {
    expect(notFound()).toMatchObject({ statusCode: 404 })
    expect(toBadRequest([{ field: 'a', message: 'b' }])).toMatchObject({
      statusCode: 400,
      data: { fields: [{ field: 'a', message: 'b' }] },
    })
  })

  it('found passes a value and turns null and undefined into 404', () => {
    expect(found(0)).toBe(0)
    expect(found('')).toBe('')
    expect(() => found(null)).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => found(undefined)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })
})
