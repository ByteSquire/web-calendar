// @vitest-environment node
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupDatabase, backupName, main, USAGE } from '../../scripts/backup-db.mjs'

let dir: string
let databaseFile: string
let backups: string
/** Kept open, as the app does: what it writes stays in the -wal file until a checkpoint. */
let writer: DatabaseSync

const NOW = new Date('2026-11-01T19:55:00.123Z')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-db-'))
  databaseFile = join(dir, 'web-calendar.db')
  backups = join(dir, 'backups')
  writer = new DatabaseSync(databaseFile)
  writer.exec(
    'PRAGMA journal_mode = WAL; CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2)',
  )
  writer.exec('INSERT INTO t VALUES (3)') // committed, and only in the -wal file
})

afterEach(() => {
  writer.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function rows(file: string): number[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db
      .prepare('SELECT a FROM t ORDER BY a')
      .all()
      .map((row) => Number(row.a))
  } finally {
    db.close()
  }
}

describe('backupName', () => {
  it('is sortable and has no colon or dot except the extension', () => {
    expect(backupName(NOW)).toBe('web-calendar-2026-11-01T19-55-00-123Z.db')
    expect(backupName(new Date('2026-11-02T00:00:00.000Z')) > backupName(NOW)).toBe(true)
  })
})

describe('backupDatabase', () => {
  it('copies everything that was committed, the -wal file included, and checks the copy', () => {
    const target = backupDatabase(databaseFile, backups, NOW)
    expect(target).toBe(join(backups, backupName(NOW)))
    expect(rows(target)).toEqual([1, 2, 3])
  })

  it('writes a file only its owner can read', () => {
    const target = backupDatabase(databaseFile, backups, NOW)
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('leaves the source alone: the writer carries on and a second backup sees its row', () => {
    backupDatabase(databaseFile, backups, NOW)
    writer.exec('INSERT INTO t VALUES (4)')
    const second = backupDatabase(databaseFile, backups, new Date(NOW.getTime() + 1000))
    expect(rows(databaseFile)).toEqual([1, 2, 3, 4])
    expect(rows(second)).toEqual([1, 2, 3, 4])
    expect(readdirSync(backups)).toHaveLength(2)
  })

  it('never writes over an existing backup', () => {
    const target = backupDatabase(databaseFile, backups, NOW)
    const before = rows(target)
    writer.exec('INSERT INTO t VALUES (9)')
    expect(() => backupDatabase(databaseFile, backups, NOW)).toThrow(/already exists/)
    expect(rows(target)).toEqual(before)
  })

  it('refuses a missing source and creates no backup for it', () => {
    expect(() => backupDatabase(join(dir, 'nope.db'), backups, NOW)).toThrow(/no database file/i)
    expect(existsSync(backups)).toBe(false)
  })

  it('does not take a file that is no database for one', () => {
    const notDatabase = join(dir, 'text.db')
    writeFileSync(notDatabase, 'this is not an SQLite file, only some text of a sufficient length')
    expect(() => backupDatabase(notDatabase, backups, NOW)).toThrow()
    expect(existsSync(join(backups, backupName(NOW)))).toBe(false)
  })
})

describe('main', () => {
  it('prints the usage and exits 2 without exactly two plain arguments', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main([])).toBe(2)
    expect(main([databaseFile])).toBe(2)
    expect(main([databaseFile, backups, 'extra'])).toBe(2)
    expect(main(['--help', backups])).toBe(2)
    expect(error).toHaveBeenCalledWith(USAGE)
  })

  it('exits 0 and names the file it wrote', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(main([databaseFile, backups])).toBe(0)
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^Backup written: .*web-calendar-.*\.db$/),
    )
    expect(readdirSync(backups)).toHaveLength(1)
  })

  it('exits 2 when the source cannot be read', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main([join(dir, 'nope.db'), backups])).toBe(2)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no database file/i))
  })
})
