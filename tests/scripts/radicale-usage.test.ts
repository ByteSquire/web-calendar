// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_SIZE,
  flaggedHomes,
  formatReport,
  formatSize,
  parseArgs,
  parseSize,
  run,
  scanHomes,
} from '../../scripts/radicale-usage.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'radicale-usage-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A file of the given size at `path` below the data directory, parents created. */
function file(path: string, bytes: number): void {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, 'x'.repeat(bytes))
}

/** A Radicale `filesystem_folder` with two homes. */
function radicale(): void {
  // alice: two calendars, three items and Radicale's own files (props, caches, a history).
  file('collection-root/alice/def-calendar/.Radicale.props', 100)
  file('collection-root/alice/def-calendar/a.ics', 1000)
  file('collection-root/alice/def-calendar/b.ics', 2000)
  file('collection-root/alice/def-calendar/.Radicale.cache/item/a.ics', 300)
  file('collection-root/alice/def-calendar/.Radicale.cache/history/gone.ics', 40)
  file('collection-root/alice/work/c.ics', 500)
  // bob: one calendar with one item.
  file('collection-root/bob/def-calendar/d.ics', 10)
  // Not homes: the lock file next to collection-root and the sharing database.
  file('.Radicale.lock', 0)
  file('collection-root/.stray', 5)
}

describe('parseSize', () => {
  it.each([
    ['0', 0],
    ['500', 500],
    ['500B', 500],
    ['1K', 1024],
    ['1k', 1024],
    ['1KiB', 1024],
    ['500M', 500 * 1024 ** 2],
    ['1.5G', 1.5 * 1024 ** 3],
    ['2 GiB', 2 * 1024 ** 3],
    ['1T', 1024 ** 4],
    [' 10M ', 10 * 1024 ** 2],
  ])('reads %j as %i bytes', (text, bytes) => {
    expect(parseSize(text)).toBe(bytes)
  })

  it.each(['', 'M', 'five', '-1M', '1.5.2G', '10X', '1MB5', '99999999999999999999T'])(
    'rejects %j',
    (text) => {
      expect(parseSize(text)).toBeNull()
    },
  )
})

describe('formatSize', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1536, '1.5 KiB'],
    [5 * 1024 ** 2, '5.0 MiB'],
    [DEFAULT_MAX_SIZE, '1.0 GiB'],
    [3 * 1024 ** 4, '3.0 TiB'],
    [5000 * 1024 ** 4, '5000.0 TiB'],
  ])('writes %i as %j', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text)
  })
})

describe('parseArgs', () => {
  it('takes the directory and the defaults', () => {
    expect(parseArgs(['/data/collections'])).toEqual({
      options: { dir: '/data/collections', maxSize: 1024 ** 3, maxItems: null, json: false },
    })
  })

  it('takes the limits and the format in any order', () => {
    expect(parseArgs(['--max-size', '500M', '/data', '--max-items', '2000', '--json'])).toEqual({
      options: { dir: '/data', maxSize: 500 * 1024 ** 2, maxItems: 2000, json: true },
    })
  })

  it.each([
    [[], 'directory is missing'],
    [['--json'], 'directory is missing'],
    [['/a', '/b'], 'unexpected argument /b'],
    [['/a', '--max-size'], '--max-size needs a value'],
    [['/a', '--max-size', 'lots'], '"lots" is not a size'],
    [['/a', '--max-items', '1.5'], '"1.5" is not a number'],
    [['/a', '--max-items', '-1'], '"-1" is not a number'],
    [['/a', '--quota', '1'], 'unknown option --quota'],
  ])('refuses %j', (argv, message) => {
    const parsed = parseArgs(argv)
    expect('error' in parsed && parsed.error).toContain(message)
  })
})

describe('scanHomes', () => {
  it('counts collections, items and the bytes of every file in each home, biggest first', () => {
    radicale()
    expect(scanHomes(dir)).toEqual([
      { name: 'alice', collections: 2, items: 3, bytes: 100 + 1000 + 2000 + 300 + 40 + 500 },
      { name: 'bob', collections: 1, items: 1, bytes: 10 },
    ])
  })

  it('takes the collection-root directory as well', () => {
    radicale()
    expect(scanHomes(join(dir, 'collection-root')).map((home) => home.name)).toEqual([
      'alice',
      'bob',
    ])
  })

  it('does not count what Radicale keeps in a collection as items', () => {
    file('collection-root/carol/cal/.Radicale.props', 10)
    file('collection-root/carol/cal/.Radicale.cache/item/x.ics', 10)
    file('collection-root/carol/cal/sub/deep.ics', 10)
    expect(scanHomes(dir)[0]).toMatchObject({ collections: 1, items: 0, bytes: 30 })
  })

  it('does not follow a symbolic link out of the home', () => {
    file('outside/big.ics', 5000)
    file('collection-root/dave/cal/a.ics', 10)
    symlinkSync(join(dir, 'outside'), join(dir, 'collection-root/dave/cal/link'))
    const [dave] = scanHomes(dir)
    expect(dave!.items).toBe(1)
    expect(dave!.bytes).toBeLessThan(1000)
  })

  it('lists no homes for an empty data directory and fails for a missing one', () => {
    mkdirSync(join(dir, 'collection-root'))
    expect(scanHomes(dir)).toEqual([])
    expect(() => scanHomes(join(dir, 'nowhere'))).toThrow()
  })

  it('breaks a tie in size by name', () => {
    file('collection-root/zed/cal/a.ics', 5)
    file('collection-root/amy/cal/a.ics', 5)
    expect(scanHomes(dir).map((home) => home.name)).toEqual(['amy', 'zed'])
  })
})

describe('flaggedHomes and formatReport', () => {
  const homes = [
    { name: 'alice', collections: 2, items: 3, bytes: 3940 },
    { name: 'bob', collections: 1, items: 1, bytes: 10 },
  ]

  it('flags a home over the size limit, not one at it', () => {
    expect(flaggedHomes(homes, { maxSize: 3939, maxItems: null }).map((h) => h.name)).toEqual([
      'alice',
    ])
    expect(flaggedHomes(homes, { maxSize: 3940, maxItems: null })).toEqual([])
  })

  it('flags a home over the item limit as well', () => {
    expect(flaggedHomes(homes, { maxSize: 1e9, maxItems: 2 }).map((h) => h.name)).toEqual(['alice'])
    expect(flaggedHomes(homes, { maxSize: 1e9, maxItems: 3 })).toEqual([])
  })

  it('writes one line per home, a total, and the verdict', () => {
    expect(formatReport(homes, { maxSize: 2048, maxItems: null })).toBe(
      [
        'home   collections     items        size',
        'alice            2         3     3.8 KiB  OVER',
        'bob              1         1        10 B',
        'total            3         4     3.9 KiB',
        '1 of 2 homes over the limit 2.0 KiB',
      ].join('\n'),
    )
  })

  it('says so when nothing is over, and names the item limit when there is one', () => {
    expect(formatReport(homes, { maxSize: 1e9, maxItems: 100 }).split('\n').at(-1)).toBe(
      '2 homes, none over the limit 953.7 MiB or 100 items',
    )
  })

  it('reports an empty data directory', () => {
    expect(formatReport([], { maxSize: 1024, maxItems: null })).toBe(
      [
        'home  collections     items        size',
        'total            0         0         0 B',
        '0 homes, none over the limit 1.0 KiB',
      ].join('\n'),
    )
  })
})

describe('run', () => {
  function call(argv: string[]) {
    const out: string[] = []
    const err: string[] = []
    const code = run(argv, { out: (text) => out.push(text), err: (text) => err.push(text) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('exits 0 and prints the report when no home is over the limit', () => {
    radicale()
    const result = call([dir, '--max-size', '1M'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('alice')
    expect(result.out).toContain('2 homes, none over the limit 1.0 MiB')
    expect(result.err).toBe('')
  })

  it('exits 1 when a home is over the size limit', () => {
    radicale()
    const result = call([dir, '--max-size', '1K'])
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/alice .*OVER/)
    expect(result.out).not.toMatch(/bob .*OVER/)
  })

  it('exits 1 when a home is over the item limit', () => {
    radicale()
    expect(call([dir, '--max-items', '2']).code).toBe(1)
    expect(call([dir, '--max-items', '3']).code).toBe(0)
  })

  it('prints JSON with the names of the flagged homes', () => {
    radicale()
    const result = call([dir, '--max-size', '1K', '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out)).toEqual({
      homes: scanHomes(dir),
      flagged: ['alice'],
    })
  })

  it('exits 2 with the usage for bad arguments, and with the reason for an unreadable directory', () => {
    const usage = call(['--max-size'])
    expect(usage.code).toBe(2)
    expect(usage.err).toContain('Usage: node scripts/radicale-usage.mjs')
    const missing = call([join(dir, 'nowhere')])
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('cannot read')
    expect(missing.out).toBe('')
  })
})
