// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ALLOWED,
  advisoriesOf,
  evaluateAudit,
  formatAudit,
  run,
} from '../../scripts/audit-prod.mjs'

// `npm audit --omit=dev --json` of 2026-10-30, trimmed to the fields the script reads.
function advisory(source: number, name: string, ghsa: string, severity: string, title: string) {
  return {
    source,
    name,
    dependency: name,
    title,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
  }
}
const NODE_FORGE = advisory(
  1240912,
  'node-forge',
  'GHSA-86w9-cpqp-85rv',
  'high',
  'node-forge RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements',
)
const DEEPMERGE = advisory(
  1243505,
  'deepmerge',
  'GHSA-gcqx-w48m-w2h4',
  'low',
  'deepmerge mergeObject() allows prototype poisoning of returned objects',
)
const ESBUILD = advisory(
  1120680,
  'esbuild',
  'GHSA-g7r4-m6w7-qqqr',
  'low',
  'esbuild allows arbitrary file read when running the development server on Windows',
)

function report(...advisories: ReturnType<typeof advisory>[]) {
  const vulnerabilities: Record<string, unknown> = {
    // Packages that only point at the advisory of another one.
    nuxt: { name: 'nuxt', severity: 'low', via: ['@nuxt/nitro-server', 'nitropack'] },
    nitropack: { name: 'nitropack', severity: 'low', via: ['@rollup/plugin-node-resolve'] },
  }
  for (const found of advisories) {
    const known = vulnerabilities[found.name] as { via: unknown[] } | undefined
    if (known) known.via.push(found)
    else vulnerabilities[found.name] = { name: found.name, severity: found.severity, via: [found] }
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: {} }
}

const TODAY = report(NODE_FORGE, DEEPMERGE, ESBUILD)

function call(audit: () => string, argv: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const code = run(argv, { out: (t) => out.push(t), err: (t) => err.push(t), audit })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const json = (value: unknown) => () => JSON.stringify(value)

describe('the allow-list', () => {
  it('holds the three advisories npm reports today, each with a reason', () => {
    expect(ALLOWED.map((entry) => [entry.id, entry.name])).toEqual([
      ['GHSA-86w9-cpqp-85rv', 'node-forge'],
      ['GHSA-gcqx-w48m-w2h4', 'deepmerge'],
      ['GHSA-g7r4-m6w7-qqqr', 'esbuild'],
    ])
    for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(40)
  })
})

describe('advisoriesOf', () => {
  it('lists each advisory once, from the entries that have one', () => {
    expect(advisoriesOf(TODAY).map((a) => a.id)).toEqual([
      'GHSA-86w9-cpqp-85rv',
      'GHSA-gcqx-w48m-w2h4',
      'GHSA-g7r4-m6w7-qqqr',
    ])
    const twice = report(NODE_FORGE)
    twice.vulnerabilities.listhen = { name: 'listhen', severity: 'high', via: [NODE_FORGE] }
    expect(advisoriesOf(twice)).toHaveLength(1)
  })

  it('keeps one entry per package when one advisory id is reported against several', () => {
    const fork = { ...NODE_FORGE, name: 'node-forge-fork', dependency: 'node-forge-fork' }
    const both = report(NODE_FORGE)
    both.vulnerabilities.fork = { name: 'node-forge-fork', severity: 'high', via: [fork] }
    expect(advisoriesOf(both).map((a) => a.name)).toEqual(['node-forge', 'node-forge-fork'])
    // The allow-list names the package, so only the allowed one is let through.
    const status = Object.fromEntries(evaluateAudit(both).judged.map((a) => [a.name, a.status]))
    expect(status).toEqual({ 'node-forge': 'allowed', 'node-forge-fork': 'blocking' })
  })

  it('falls back to the npm id for an advisory without a GHSA url', () => {
    const odd = report({ ...NODE_FORGE, url: 'https://example.org/other' })
    expect(advisoriesOf(odd)[0]!.id).toBe('npm:1240912')
  })

  it('is empty for a clean report and throws for one without the vulnerabilities', () => {
    expect(advisoriesOf({ vulnerabilities: {} })).toEqual([])
    expect(() => advisoriesOf({})).toThrow('no "vulnerabilities"')
    expect(() => advisoriesOf(null)).toThrow('no "vulnerabilities"')
  })
})

describe('evaluateAudit', () => {
  const statuses = (value: unknown, minSeverity?: string) =>
    Object.fromEntries(evaluateAudit(value, { minSeverity }).judged.map((a) => [a.name, a.status]))

  it('allows all three advisories of today’s report', () => {
    expect(statuses(TODAY)).toEqual({
      'node-forge': 'allowed',
      deepmerge: 'allowed',
      esbuild: 'allowed',
    })
  })

  it('lists what is below a threshold that was set on purpose, and still fails the rest', () => {
    const fresh = advisory(5, 'jose', 'GHSA-low0-low0-low0', 'low', 'new and low')
    expect(statuses(report(fresh), 'moderate')).toEqual({ jose: 'below' })
    expect(statuses(report(fresh), 'low')).toEqual({ jose: 'blocking' })
  })

  it('matches by advisory id: a second advisory for node-forge is new', () => {
    const second = advisory(2, 'node-forge', 'GHSA-xxxx-yyyy-zzzz', 'high', 'another one')
    const judged = evaluateAudit(report(NODE_FORGE, second)).judged
    expect(judged.map((a) => [a.id, a.status])).toEqual([
      ['GHSA-86w9-cpqp-85rv', 'allowed'],
      ['GHSA-xxxx-yyyy-zzzz', 'blocking'],
    ])
  })

  it('does not allow the known id on another package', () => {
    const elsewhere = advisory(3, 'other-forge', 'GHSA-86w9-cpqp-85rv', 'high', 'same id')
    expect(statuses(report(elsewhere))).toEqual({ 'other-forge': 'blocking' })
  })

  it.each([
    ['critical', 'blocking'],
    ['high', 'blocking'],
    ['moderate', 'blocking'],
    ['low', 'blocking'],
    ['info', 'blocking'],
    ['unheard-of', 'blocking'],
  ])('a new %s advisory fails with the default threshold', (severity, status) => {
    const fresh = advisory(4, 'jose', 'GHSA-aaaa-bbbb-cccc', severity, 'new')
    expect(statuses(report(fresh))).toEqual({ jose: status })
  })

  it.each([
    ['moderate', 'critical', 'blocking'],
    ['moderate', 'moderate', 'blocking'],
    ['moderate', 'low', 'below'],
    ['high', 'moderate', 'below'],
    ['high', 'high', 'blocking'],
    ['critical', 'high', 'below'],
    // An unknown severity cannot be shown to be harmless, whatever the threshold.
    ['critical', 'unheard-of', 'blocking'],
  ])('with --min-severity %s a new %s advisory is %s', (minSeverity, severity, status) => {
    const fresh = advisory(4, 'jose', 'GHSA-aaaa-bbbb-cccc', severity, 'new')
    expect(statuses(report(fresh), minSeverity)).toEqual({ jose: status })
  })

  it('names an allowed advisory npm no longer reports', () => {
    expect(evaluateAudit(report(DEEPMERGE)).stale.map((entry) => entry.id)).toEqual([
      'GHSA-86w9-cpqp-85rv',
      'GHSA-g7r4-m6w7-qqqr',
    ])
    expect(evaluateAudit(TODAY).stale).toEqual([])
  })

  it('throws for npm’s error report and for an unknown threshold', () => {
    expect(() =>
      evaluateAudit({ error: { code: 'ENOTFOUND', summary: 'request to the registry failed' } }),
    ).toThrow('npm audit failed: ENOTFOUND request to the registry failed')
    expect(() => evaluateAudit(TODAY, { minSeverity: 'severe' })).toThrow('unknown severity')
  })

  it('takes another allow-list', () => {
    const own = [{ id: 'GHSA-gcqx-w48m-w2h4', name: 'deepmerge', reason: 'build time only' }]
    const result = evaluateAudit(TODAY, { allowed: own })
    expect(Object.fromEntries(result.judged.map((a) => [a.name, a.status]))).toEqual({
      'node-forge': 'blocking',
      deepmerge: 'allowed',
      esbuild: 'blocking',
    })
  })
})

describe('formatAudit', () => {
  it('writes a line per advisory and the verdict', () => {
    const text = formatAudit(evaluateAudit(TODAY), 'info')
    expect(text).toContain('allowed        high      node-forge: node-forge RSA PKCS#1')
    expect(text).toContain('allowed        low       deepmerge: deepmerge mergeObject()')
    expect(text.split('\n').at(-1)).toBe('audit:prod: no advisory that is not allowed (3 reported)')
  })

  it('links the new advisories in the verdict', () => {
    const fresh = advisory(4, 'jose', 'GHSA-aaaa-bbbb-cccc', 'high', 'new')
    const text = formatAudit(evaluateAudit(report(fresh)), 'info')
    expect(text).toContain('NEW')
    expect(text.split('\n').at(-1)).toBe(
      'audit:prod: 1 advisory(ies) that are not allowed: https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    )
  })

  it('marks an advisory below a threshold that was set on purpose', () => {
    const fresh = advisory(5, 'jose', 'GHSA-low0-low0-low0', 'low', 'new and low')
    const text = formatAudit(evaluateAudit(report(fresh), { minSeverity: 'high' }), 'high')
    expect(text).toContain('below high     low       jose: new and low')
  })

  it('tells the operator to drop a stale entry', () => {
    expect(formatAudit(evaluateAudit(report()), 'info')).toContain(
      'npm no longer reports GHSA-86w9-cpqp-85rv (node-forge): remove it from ALLOWED',
    )
  })
})

describe('run', () => {
  it('exits 0 for today’s report', () => {
    const result = call(json(TODAY))
    expect(result.code).toBe(0)
    expect(result.out).toContain('node-forge')
    expect(result.err).toBe('')
  })

  it('exits 1 for a new advisory of any severity, unless it is below a threshold set on purpose', () => {
    const fresh = advisory(4, 'jose', 'GHSA-aaaa-bbbb-cccc', 'high', 'new')
    const low = advisory(5, 'jose', 'GHSA-low0-low0-low0', 'low', 'new and low')
    expect(call(json(report(NODE_FORGE, fresh))).code).toBe(1)
    expect(call(json(report(NODE_FORGE, low))).code).toBe(1)
    expect(call(json(report(NODE_FORGE, low)), ['--min-severity', 'moderate']).code).toBe(0)
    expect(call(json(report(NODE_FORGE, fresh)), ['--min-severity', 'moderate']).code).toBe(1)
  })

  it('exits 0 for a clean report', () => {
    expect(call(json({ vulnerabilities: {} })).code).toBe(0)
  })

  it('exits 2 when the audit could not be read: an audit that did not run does not pass', () => {
    expect(call(() => 'not json').code).toBe(2)
    expect(call(() => '').code).toBe(2)
    expect(call(json({ error: { code: 'ENOTFOUND', summary: 'offline' } })).code).toBe(2)
    expect(call(json({ metadata: {} })).code).toBe(2)
    const thrown = call(() => {
      throw new Error('npm audit printed nothing')
    })
    expect(thrown.code).toBe(2)
    expect(thrown.err).toContain('could not audit: npm audit printed nothing')
    expect(thrown.out).toBe('')
  })

  it('exits 2 for arguments it does not know', () => {
    expect(call(json(TODAY), ['--fix']).code).toBe(2)
    expect(call(json(TODAY), ['--min-severity']).code).toBe(2)
    expect(call(json(TODAY), ['--min-severity', 'severe']).err).toContain('unknown severity')
  })
})
