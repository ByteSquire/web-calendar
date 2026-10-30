#!/usr/bin/env node
// Storage per user home of a Radicale data directory (security review L8). Radicale has no quota: a
// signed-in user may create calendars and objects without bound (10 MB per request, see
// deploy/radicale/config), so an operator checks the volume now and then. This lists every home
// with its size and item count, flags the ones above a limit, and exits 1 when there is one (2 on a
// usage or read error), so a cron job or a monitoring check can use the exit code.
//
//   node scripts/radicale-usage.mjs <collections-dir> [--max-size 1G] [--max-items N] [--json]
//
// <collections-dir> is Radicale's `filesystem_folder` (`/var/lib/radicale/collections` in the
// image) or the `collection-root` directory in it. Homes are named after the user id the gateway
// sends: the Kanidm `sub`. Size is the bytes of all files in the home (items, properties and
// Radicale's caches); an item is a file that does not start with a dot. A size takes K, M, G or T
// (powers of 1024).
//
// The app container has no access to Radicale's volume and should not get any. Run this on the host
// against the volume, read-only, in a throwaway container (the volume name is `docker volume ls`):
//
//   docker run --rm -v web-calendar_radicale-data:/data:ro -v "$PWD/scripts:/scripts:ro" \
//     node:24-bookworm-slim node /scripts/radicale-usage.mjs /data/collections --max-size 500M
//
// No dependencies; nothing is written. The functions are exported for
// tests/scripts/radicale-usage.test.ts.
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_MAX_SIZE = 1024 ** 3
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
const SIZE = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i

export const USAGE =
  'Usage: node scripts/radicale-usage.mjs <collections-dir> [--max-size 1G] [--max-items N] [--json]'

/**
 * A size such as `500`, `500K`, `1.5G` or `2GiB` in bytes (powers of 1024), or null.
 * @param {string} text
 * @returns {number | null}
 */
export function parseSize(text) {
  const match = SIZE.exec(text.trim())
  if (!match) return null
  const bytes = Math.floor(
    Number(match[1]) * 1024 ** 'BKMGT'.indexOf((match[2] || 'B').toUpperCase()),
  )
  return Number.isSafeInteger(bytes) ? bytes : null
}

/**
 * Bytes as `1.5 MiB`: one decimal from KiB up.
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`
}

/**
 * @typedef {{ dir: string, maxSize: number, maxItems: number | null, json: boolean }} Options
 * @param {string[]} argv the arguments after the script name
 * @returns {{ options: Options } | { error: string }}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { dir: '', maxSize: DEFAULT_MAX_SIZE, maxItems: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--max-size' || arg === '--max-items') {
      const value = argv[++i]
      if (value === undefined) return { error: `${arg} needs a value` }
      if (arg === '--max-size') {
        const size = parseSize(value)
        if (size === null) return { error: `--max-size: "${value}" is not a size such as 500M` }
        options.maxSize = size
      } else {
        if (!/^\d{1,15}$/.test(value)) return { error: `--max-items: "${value}" is not a number` }
        options.maxItems = Number(value)
      }
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${arg}` }
    } else if (options.dir === '') {
      options.dir = arg
    } else {
      return { error: `unexpected argument ${arg}` }
    }
  }
  if (options.dir === '') return { error: 'the collections directory is missing' }
  return { options }
}

/**
 * @typedef {{ name: string, collections: number, items: number, bytes: number }} Home
 */

/**
 * Walks one home. Symbolic links are not followed; they count with their own size only. Directories
 * add nothing to the size (their own size is the file system's bookkeeping).
 * @param {string} home
 * @returns {Omit<Home, 'name'>}
 */
function scanHome(home) {
  const usage = { collections: 0, items: 0, bytes: 0 }
  // level 0 is the home, 1 a collection (a calendar), 2 anything below one or a dot directory such
  // as `.Radicale.cache`, whose files are Radicale's own and no items.
  /** @param {string} dir @param {number} level */
  const walk = (dir, level) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        const collection = level === 0 && !entry.startsWith('.')
        if (collection) usage.collections++
        walk(path, collection ? 1 : 2)
        continue
      }
      usage.bytes += stat.size
      if (stat.isFile() && level === 1 && !entry.startsWith('.')) usage.items++
    }
  }
  walk(home, 0)
  return usage
}

/**
 * The homes of a Radicale data directory, biggest first. Accepts the `filesystem_folder` or its
 * `collection-root`.
 * @param {string} dir
 * @returns {Home[]}
 */
export function scanHomes(dir) {
  let root = dir
  try {
    if (lstatSync(join(dir, 'collection-root')).isDirectory()) root = join(dir, 'collection-root')
  } catch {
    // `dir` is the collection root itself.
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, ...scanHome(join(root, entry.name)) }))
    .sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1))
}

/**
 * The homes above a limit.
 * @param {Home[]} homes
 * @param {Pick<Options, 'maxSize' | 'maxItems'>} limits
 * @returns {Home[]}
 */
export function flaggedHomes(homes, limits) {
  return homes.filter(
    (home) =>
      home.bytes > limits.maxSize || (limits.maxItems !== null && home.items > limits.maxItems),
  )
}

/**
 * The report as text: one line per home, a mark on the flagged ones, a total.
 * @param {Home[]} homes
 * @param {Pick<Options, 'maxSize' | 'maxItems'>} limits
 * @returns {string}
 */
export function formatReport(homes, limits) {
  const flagged = new Set(flaggedHomes(homes, limits))
  const width = Math.max(4, ...homes.map((home) => home.name.length))
  /** @param {string[]} cells */
  const line = (cells) => {
    const [name = '', collections = '', items = '', size = '', mark = ''] = cells
    return `${name.padEnd(width)}  ${collections.padStart(11)}  ${items.padStart(8)}  ${size.padStart(10)}  ${mark}`.trimEnd()
  }
  const lines = [line(['home', 'collections', 'items', 'size', ''])]
  for (const home of homes) {
    lines.push(
      line([
        home.name,
        String(home.collections),
        String(home.items),
        formatSize(home.bytes),
        flagged.has(home) ? 'OVER' : '',
      ]),
    )
  }
  const items = homes.reduce((sum, home) => sum + home.items, 0)
  const collections = homes.reduce((sum, home) => sum + home.collections, 0)
  const bytes = homes.reduce((sum, home) => sum + home.bytes, 0)
  lines.push(line(['total', String(collections), String(items), formatSize(bytes), '']))
  const limit =
    `limit ${formatSize(limits.maxSize)}` +
    (limits.maxItems === null ? '' : ` or ${limits.maxItems} items`)
  lines.push(
    flagged.size === 0
      ? `${homes.length} homes, none over the ${limit}`
      : `${flagged.size} of ${homes.length} homes over the ${limit}`,
  )
  return lines.join('\n')
}

/**
 * @param {string[]} argv
 * @param {{ out: (text: string) => void, err: (text: string) => void }} io
 * @returns {number} the exit code
 */
export function run(argv, io) {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    io.err(`${parsed.error}\n${USAGE}`)
    return 2
  }
  const { options } = parsed
  let homes
  try {
    homes = scanHomes(options.dir)
  } catch (error) {
    io.err(`cannot read ${options.dir}: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const flagged = flaggedHomes(homes, options)
  io.out(
    options.json
      ? JSON.stringify({ homes, flagged: flagged.map((home) => home.name) }, null, 2)
      : formatReport(homes, options),
  )
  return flagged.length > 0 ? 1 : 0
}

// Run as a script; importing the module has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  })
}
