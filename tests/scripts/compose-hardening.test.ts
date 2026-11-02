// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The hardening of the example deployment (security review 2026-11-01, finding 8 and §4): both
// containers read-only, without capabilities and without privilege escalation, Radicale reachable
// only on an internal network, and the static Radicale rights that give each user their own home.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const compose = read('../../docker-compose.yml')

/** The lines of a top-level block (`services:`) or of a service in it, comments dropped. */
function block(text: string, name: string, indent: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `${indent}${name}:`)
  expect(start, `${name} is in docker-compose.yml`).toBeGreaterThanOrEqual(0)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(`${indent} `)) break
    if (line.trim().startsWith('#') || line.trim() === '') continue
    body.push(line.replace(/\s+#.*$/, ''))
  }
  return body.join('\n')
}

const services = block(compose, 'services', '')

describe.each(['web-calendar', 'radicale'])('the %s service in docker-compose.yml', (name) => {
  const service = block(services, name, '  ')

  it('has a read-only root file system', () => {
    expect(service).toMatch(/^ {4}read_only: true$/m)
  })

  it('drops every capability', () => {
    expect(service).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m)
  })

  it('forbids gaining privileges', () => {
    expect(service).toMatch(/^ {4}security_opt:\n {6}- no-new-privileges:true$/m)
  })

  it('is on the radicale network', () => {
    expect(service).toMatch(/^ {4}networks:\n(?: {6}- \S+\n)*? {6}- radicale$/m)
  })
})

describe('Radicale in docker-compose.yml', () => {
  const radicale = block(services, 'radicale', '  ')

  it('publishes no port and is on no other network', () => {
    expect(radicale).not.toMatch(/^ {4}(ports|expose|network_mode):/m)
    expect(radicale).toMatch(/^ {4}networks:\n {6}- radicale\n {4}\S/m)
  })

  it('mounts its rights, config and group file read-only', () => {
    expect(radicale).toContain('- ./deploy/radicale/rights:/etc/radicale/rights:ro')
    expect(radicale).toContain('- ./deploy/radicale/config:/etc/radicale/config:ro')
    expect(radicale).toContain('- radicale-groups:/etc/radicale/groups:ro')
  })

  it('has an internal network, so nothing outside the app can reach it', () => {
    expect(block(compose, 'networks', '')).toMatch(/^ {2}radicale:\n {4}internal: true$/m)
  })

  it('publishes the app on loopback only', () => {
    expect(block(services, 'web-calendar', '  ')).toMatch(
      /^ {4}ports:\n {6}- '127\.0\.0\.1:\d+:\d+'$/m,
    )
  })
})

describe('deploy/radicale/rights', () => {
  /** The sections in file order, each as its key/value pairs. */
  const sections = [
    ...read('../../deploy/radicale/rights')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .matchAll(/^\[([^\]]+)\]\n((?:[^[\n].*\n?)*)/gm),
  ].map(([, name, body]) => ({
    name,
    entries: Object.fromEntries(
      (body ?? '')
        .split('\n')
        .filter((line) => line.includes(':'))
        .map((line) => [
          line.slice(0, line.indexOf(':')).trim(),
          line.slice(line.indexOf(':') + 1).trim(),
        ]),
    ),
  }))

  it('has exactly these rules, in this order (the first match wins)', () => {
    expect(sections).toEqual([
      { name: 'root', entries: { user: '.+', collection: '', permissions: 'R' } },
      { name: 'principal', entries: { user: '.+', collection: '{user}', permissions: 'RW' } },
      { name: 'calendars', entries: { user: '.+', collection: '{user}/[^/]+', permissions: 'rw' } },
    ])
  })

  it('gives no anonymous access and no access to another user’s collections', () => {
    for (const { entries } of sections) {
      expect(entries.user).toBe('.+')
      expect(entries.collection === '' || entries.collection?.startsWith('{user}')).toBe(true)
    }
  })
})
