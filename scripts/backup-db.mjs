#!/usr/bin/env node
// Backup of the app's SQLite file (security review 2026-11-01, finding 7; review guide §7.9).
// `VACUUM INTO` writes a consistent copy while the app keeps running, including what is still in
// the -wal file; a plain copy of a WAL database can miss committed data (and is not a backup).
//
//   node scripts/backup-db.mjs <database-file> <backup-dir>
//
// Writes <backup-dir>/web-calendar-<UTC time>.db (mode 0600, never over an existing file), then
// opens the copy and runs `PRAGMA integrity_check` on it. The source is opened read-only: this
// script cannot change it. Exit codes: 0 done, 1 the copy failed its integrity check (and was
// removed), 2 usage error or the source could not be read.
//
// What a backup is (guide §7.9): this file AND `radicale-data`, including sharing.csv, which is
// authorization state. The hash key is not in the file and must be kept apart from it. Encrypt
// the backups at rest and restrict who can read them. To restore: stop the app, put the copy in
// place of web-calendar.db (delete the old -wal and -shm files), start the app, and let the
// sharing reconcile run (it re-checks Radicale's sharing database against this one).
//
// The runtime image has no scripts and no tools. Run it on the host in a throwaway container,
// with the data volume (the name is `docker volume ls`) and a folder for the backups:
//
//   docker run --rm --user 1000:1000 -v web-calendar_web-calendar-data:/data \
//     -v "$PWD/scripts:/scripts:ro" -v "$PWD/backups:/backups" \
//     node:24-bookworm-slim node /scripts/backup-db.mjs /data/web-calendar.db /backups
//
// No dependencies: it uses node:sqlite, which Node 24 ships. The functions are exported for
// tests/scripts/backup-db.test.ts.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

export const USAGE = 'Usage: node scripts/backup-db.mjs <database-file> <backup-dir>'

/** The file name of a backup made at `now`: sortable, and with no character a shell dislikes. */
export function backupName(now) {
  return `web-calendar-${now.toISOString().replace(/[:.]/g, '-')}.db`
}

/** Thrown when the copy does not pass `PRAGMA integrity_check`. */
export class IntegrityError extends Error {}

/**
 * Makes the backup and checks it. Returns where it is. Throws an IntegrityError (after removing the
 * copy) when the copy is not sound, and a plain Error when the source is missing or unreadable or
 * the target already exists.
 * @param {string} databaseFile
 * @param {string} backupDir
 * @param {Date} [now]
 * @returns {string}
 */
export function backupDatabase(databaseFile, backupDir, now = new Date()) {
  if (!existsSync(databaseFile)) throw new Error(`There is no database file at ${databaseFile}`)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const target = join(resolve(backupDir), backupName(now))
  if (existsSync(target)) throw new Error(`${target} already exists; not overwriting it`)

  const source = new DatabaseSync(databaseFile, { readOnly: true })
  try {
    source.prepare('VACUUM INTO ?').run(target)
  } finally {
    source.close()
  }
  chmodSync(target, 0o600)

  const copy = new DatabaseSync(target, { readOnly: true })
  try {
    const rows = copy.prepare('PRAGMA integrity_check').all()
    const verdict = rows.map((row) => String(row.integrity_check))
    if (verdict.length !== 1 || verdict[0] !== 'ok') {
      throw new IntegrityError(`The copy failed its integrity check: ${verdict.join('; ')}`)
    }
  } catch (error) {
    copy.close()
    rmSync(target, { force: true })
    throw error
  }
  copy.close()
  return target
}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {number} the exit code
 */
export function main(argv) {
  if (argv.length !== 2 || argv.some((arg) => arg.startsWith('-'))) {
    console.error(USAGE)
    return 2
  }
  try {
    console.log(`Backup written: ${backupDatabase(argv[0], argv[1])}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return error instanceof IntegrityError ? 1 : 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
