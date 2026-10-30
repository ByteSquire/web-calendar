#!/usr/bin/env node
// `npm audit --omit=dev` that fails on anything new (security review I1, backlog 16). npm exits 1
// for any advisory, which includes the one this project knows and accepts (README "Known issues"),
// so a plain `npm audit` could never be part of a check. This runs it, reads the JSON report and
// compares the advisories with ALLOWED, by advisory id (the GHSA id), not by package: a second
// advisory for node-forge is new.
//
//   npm run audit:prod [-- --min-severity info|low|moderate|high|critical]
//
// Exit codes: 0 nothing new, 1 an advisory that is not allowed, 2 the audit could not be read (no
// network, no lockfile, unexpected output): an audit that did not run must not pass.
//
// Anything new fails, whatever its severity. npm reports three advisories today (below), each of
// them listed in ALLOWED with the reason it is accepted: none has a fix short of downgrading Nuxt
// (design §12: no `npm audit fix`). `--min-severity` loosens the check on purpose: advisories below
// it are listed, but do not fail.
//
// No dependencies. The functions are exported for tests/scripts/audit-prod.test.ts.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * Advisories the project knows and accepts (security review I1; the first one is README "Known
 * issues"). Each needs a reason; one that npm stops reporting is
 * mentioned, so the entry can go.
 * @type {{ id: string, name: string, reason: string }[]}
 */
export const ALLOWED = [
  {
    id: 'GHSA-86w9-cpqp-85rv',
    name: 'node-forge',
    reason:
      'RSA PKCS#1 v1.5 verification in node-forge, reached through listhen, the dev and preview ' +
      'server of Nitro. .output/server does not contain it (npm run test:gateway:prod checks), ' +
      'and there is no patched version (README "Known issues").',
  },
  {
    id: 'GHSA-gcqx-w48m-w2h4',
    name: 'deepmerge',
    reason:
      'Prototype poisoning in deepmerge, which the build tools of Nuxt use to merge their own ' +
      'configuration; it is not part of the production server (security review I1). Fixing it ' +
      'means downgrading Nuxt.',
  },
  {
    id: 'GHSA-g7r4-m6w7-qqqr',
    name: 'esbuild',
    reason:
      'esbuild can read arbitrary files through its development server on Windows. esbuild is ' +
      'a build tool here and its server is never started (security review I1). Fixing it means ' +
      'downgrading Nuxt.',
  },
]

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
export const DEFAULT_MIN_SEVERITY = 'info'

/**
 * @typedef {{ id: string, name: string, severity: string, title: string, url: string }} Advisory
 * @typedef {Advisory & { status: 'allowed' | 'below' | 'blocking' }} Judged
 */

/**
 * The advisories of an `npm audit --json` report (version 2), once each. A `via` entry that is a
 * string only points at another package's advisory.
 * @param {unknown} report
 * @returns {Advisory[]}
 */
export function advisoriesOf(report) {
  const vulnerabilities = /** @type {{ vulnerabilities?: unknown }} */ (report)?.vulnerabilities
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) {
    throw new Error('the report has no "vulnerabilities" object')
  }
  /** @type {Map<string, Advisory>} */
  const found = new Map()
  for (const entry of Object.values(vulnerabilities)) {
    for (const via of /** @type {{ via?: unknown[] }} */ (entry).via ?? []) {
      if (typeof via !== 'object' || via === null) continue
      const advisory = /** @type {Record<string, unknown>} */ (via)
      const url = String(advisory.url ?? '')
      const ghsa = /\/advisories\/(GHSA-[0-9a-z-]+)\/?$/i.exec(url)?.[1]
      const id = ghsa ?? (advisory.source === undefined ? url : `npm:${String(advisory.source)}`)
      if (!id) throw new Error('an advisory in the report has neither a GHSA url nor a source id')
      // An advisory npm reports against several packages is one entry per package: the allow-list
      // names the package too, so one allowed package must not hide another.
      const name = String(advisory.name ?? advisory.dependency ?? '')
      const key = `${id}\n${name}`
      if (found.has(key)) continue
      found.set(key, {
        id,
        name,
        severity: String(advisory.severity ?? ''),
        title: String(advisory.title ?? ''),
        url,
      })
    }
  }
  return [...found.values()]
}

/**
 * Sorts the advisories of a report into allowed, below the severity that fails, and blocking.
 * Throws for an error report or an unreadable one.
 * @param {unknown} report
 * @param {{ allowed?: typeof ALLOWED, minSeverity?: string }} [options]
 * @returns {{ judged: Judged[], stale: typeof ALLOWED }}
 */
export function evaluateAudit(report, options = {}) {
  const allowed = options.allowed ?? ALLOWED
  const minSeverity = options.minSeverity ?? DEFAULT_MIN_SEVERITY
  const threshold = SEVERITIES.indexOf(minSeverity)
  if (threshold === -1) throw new Error(`unknown severity "${minSeverity}"`)
  const failure = /** @type {{ error?: { code?: string, summary?: string } }} */ (report)?.error
  if (failure) {
    throw new Error(`npm audit failed: ${failure.code ?? ''} ${failure.summary ?? ''}`.trim())
  }

  const advisories = advisoriesOf(report)
  /** @type {Judged[]} */
  const judged = advisories.map((advisory) => {
    const accepted = allowed.some(
      (entry) => entry.id === advisory.id && entry.name === advisory.name,
    )
    // An unknown severity counts as the worst: it cannot be shown to be harmless.
    const rank = SEVERITIES.indexOf(advisory.severity)
    return {
      ...advisory,
      status: accepted ? 'allowed' : rank !== -1 && rank < threshold ? 'below' : 'blocking',
    }
  })
  const stale = allowed.filter((entry) => !advisories.some((advisory) => advisory.id === entry.id))
  return { judged, stale }
}

/**
 * The report as text.
 * @param {{ judged: Judged[], stale: typeof ALLOWED }} result
 * @param {string} minSeverity
 * @returns {string}
 */
export function formatAudit(result, minSeverity) {
  const label = { allowed: 'allowed', below: `below ${minSeverity}`, blocking: 'NEW' }
  const lines = result.judged.map(
    (advisory) =>
      `${label[advisory.status].padEnd(14)} ${advisory.severity.padEnd(9)} ${advisory.name}: ${advisory.title} (${advisory.id})`,
  )
  for (const entry of result.stale) {
    lines.push(`npm no longer reports ${entry.id} (${entry.name}): remove it from ALLOWED`)
  }
  const blocking = result.judged.filter((advisory) => advisory.status === 'blocking')
  lines.push(
    blocking.length === 0
      ? `audit:prod: no advisory that is not allowed (${result.judged.length} reported)`
      : `audit:prod: ${blocking.length} advisory(ies) that are not allowed: ${blocking.map((a) => a.url || a.id).join(', ')}`,
  )
  return lines.join('\n')
}

/**
 * Runs the audit and judges it.
 * @param {string[]} argv
 * @param {{ out: (text: string) => void, err: (text: string) => void, audit?: () => string }} io
 *   `audit` returns the JSON text of `npm audit --omit=dev --json`
 * @returns {number} the exit code
 */
export function run(argv, io) {
  let minSeverity = DEFAULT_MIN_SEVERITY
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-severity' && argv[i + 1] !== undefined) {
      minSeverity = String(argv[++i])
    } else {
      io.err('Usage: node scripts/audit-prod.mjs [--min-severity info|low|moderate|high|critical]')
      return 2
    }
  }
  if (!SEVERITIES.includes(minSeverity)) {
    io.err(`unknown severity "${minSeverity}"`)
    return 2
  }
  try {
    const text = (io.audit ?? npmAudit)()
    const result = evaluateAudit(JSON.parse(text), { minSeverity })
    io.out(formatAudit(result, minSeverity))
    return result.judged.some((advisory) => advisory.status === 'blocking') ? 1 : 0
  } catch (error) {
    io.err(`audit:prod could not audit: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

// npm exits 1 whenever it finds something, so only the output matters.
function npmAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (!result.stdout.trim()) throw new Error(`npm audit printed nothing: ${result.stderr.trim()}`)
  return result.stdout
}

// Run as a script; importing the module has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  })
}
