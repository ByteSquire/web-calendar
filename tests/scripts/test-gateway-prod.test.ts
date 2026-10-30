// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSocketServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_ONLY_PACKAGES,
  TEST_FILES,
  checkOutput,
  freePort,
  layerSource,
  parseArgs,
  serverEnv,
  waitForUrl,
} from '../../scripts/test-gateway-prod.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))

describe('parseArgs', () => {
  it('builds into a temporary directory by default', () => {
    expect(parseArgs([])).toEqual({ options: { output: null, keep: false, verbose: false } })
  })

  it('takes a build to test instead of building', () => {
    expect(parseArgs(['--output', 'dist-test'])).toEqual({
      options: { output: 'dist-test', keep: false, verbose: false },
    })
    expect(parseArgs(['--skip-build', '--keep', '--verbose'])).toEqual({
      options: { output: '.output', keep: true, verbose: true },
    })
  })

  it.each([
    [['--output'], '--output needs a directory'],
    [['--output', '--keep'], '--output needs a directory'],
    [['--build'], 'unknown argument --build'],
    [['somewhere'], 'unknown argument somewhere'],
  ])('refuses %j', (argv, error) => {
    expect(parseArgs(argv)).toEqual({ error })
  })
})

describe('layerSource', () => {
  it('is a Nuxt layer that moves the build directory and the Nitro output, and nothing else', async () => {
    const source = layerSource('/tmp/wcal/nuxt', '/tmp/wcal/output')
    const layer = await import(`data:text/javascript,${encodeURIComponent(source)}`)
    expect(layer.default).toEqual({
      buildDir: '/tmp/wcal/nuxt',
      nitro: { output: { dir: '/tmp/wcal/output' } },
    })
  })

  it('writes paths with odd characters as text, not as code', async () => {
    const source = layerSource('/tmp/a "b"/nuxt', "/tmp/a 'b'\\output")
    const layer = await import(`data:text/javascript,${encodeURIComponent(source)}`)
    expect(layer.default.buildDir).toBe('/tmp/a "b"/nuxt')
    expect(layer.default.nitro.output.dir).toBe("/tmp/a 'b'\\output")
  })
})

describe('serverEnv', () => {
  const settings = {
    port: 4321,
    issuer: 'http://127.0.0.1:1/oauth2/openid/web-calendar',
    radicaleUrl: 'http://127.0.0.1:2',
    dbPath: '/tmp/wcal/web-calendar.db',
    hashKey: 'k'.repeat(44),
  }

  it('configures the production server for the fakes', () => {
    expect(serverEnv(settings)).toEqual({
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '4321',
      TZ: 'Europe/Berlin',
      NUXT_OIDC_ISSUER: settings.issuer,
      NUXT_RADICALE_URL: settings.radicaleUrl,
      NUXT_TOKEN_HASH_KEY: settings.hashKey,
      NUXT_DB_PATH: settings.dbPath,
    })
  })

  it('takes nothing from the caller’s environment that could change what is tested', () => {
    vi.stubEnv('NUXT_DEMO', 'true')
    vi.stubEnv('NUXT_GATEWAY_TRUST_FORWARDED_FOR', 'true')
    vi.stubEnv('NUXT_TOKEN_HASH_KEYS', '2:x')
    try {
      const env = serverEnv(settings)
      expect(
        Object.keys(env)
          .filter((name) => name !== 'NUXT_OIDC_ISSUER' && name.startsWith('NUXT_'))
          .sort(),
      ).toEqual(['NUXT_DB_PATH', 'NUXT_RADICALE_URL', 'NUXT_TOKEN_HASH_KEY'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('meets its own validator except for the issuer scheme, which only the container checks', async () => {
    const { validateEnv } = await import('../../server/validate-config.mjs')
    const { errors } = validateEnv({
      ...serverEnv(settings),
      NUXT_OIDC_ISSUER: 'https://idm.test/web-calendar',
    })
    expect(errors).toEqual([])
  })
})

describe('checkOutput', () => {
  let output: string

  beforeEach(() => {
    output = mkdtempSync(join(tmpdir(), 'check-output-'))
  })

  afterEach(() => {
    rmSync(output, { recursive: true, force: true })
  })

  function file(path: string, text = ''): void {
    const full = join(output, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }

  it('finds nothing wrong with a server without the dev-only packages', () => {
    file('server/index.mjs', 'import "./chunks/app.mjs"')
    file('server/chunks/app.mjs', 'export const x = 1')
    file('server/node_modules/better-sqlite3/package.json', '{}')
    expect(checkOutput(output)).toEqual({ problems: [], notes: [] })
  })

  it('reports a directory that is not a build', () => {
    expect(checkOutput(output).problems).toEqual([
      expect.stringContaining('server/index.mjs does not exist'),
    ])
  })

  it.each(DEV_ONLY_PACKAGES)('fails when %s is in server/node_modules', (name) => {
    file('server/index.mjs', '')
    file(`server/node_modules/${name}/package.json`, '{}')
    expect(checkOutput(output).problems).toEqual([
      `the production server contains ${name} (server/node_modules/${name})`,
    ])
  })

  it('only notes a mention in the bundle, and does not read node_modules for it', () => {
    file('server/index.mjs', '')
    file('server/chunks/nitro.mjs', '// the dev server uses listhen')
    file('server/node_modules/some-package/index.mjs', 'require("node-forge")')
    const { problems, notes } = checkOutput(output)
    expect(problems).toEqual([])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('listhen is mentioned in 1 bundle file(s)')
    expect(notes[0]).toContain('nitro.mjs')
  })
})

describe('freePort and waitForUrl', () => {
  it('gives a port that can be bound right away', async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(1023)
    await new Promise<void>((resolve, reject) => {
      const server = createSocketServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
    })
  })

  it('waits until the URL answers 200', async () => {
    let answers = 0
    const server = createServer((_request, response) => {
      response.writeHead(++answers < 3 ? 503 : 200).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      await waitForUrl(url, { intervalMs: 10 })
      expect(answers).toBe(3)
    } finally {
      server.close()
    }
  })

  it('keeps trying while nothing listens, and gives up at the deadline', async () => {
    const url = `http://127.0.0.1:${await freePort()}/`
    await expect(waitForUrl(url, { timeoutMs: 150, intervalMs: 20 })).rejects.toThrow(
      'did not answer 200 in time',
    )
  })

  it('stops at once when the server is known to be gone', async () => {
    const url = `http://127.0.0.1:${await freePort()}/`
    await expect(
      waitForUrl(url, { timeoutMs: 60_000, failed: () => 'the server exited with 1' }),
    ).rejects.toThrow('the server exited with 1')
  })
})

describe('what the runner runs', () => {
  it('names test files that exist and that are gated on GATEWAY_IT', () => {
    for (const path of TEST_FILES) {
      expect(existsSync(join(repo, path))).toBe(true)
      expect(readFileSync(join(repo, path), 'utf8')).toContain("process.env.GATEWAY_IT === '1'")
    }
  })

  it('is wired to the npm scripts of the task', () => {
    const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >
    expect(scripts['test:gateway:prod']).toBe('node scripts/test-gateway-prod.mjs')
    expect(scripts['audit:prod']).toBe('node scripts/audit-prod.mjs')
    expect(scripts['radicale:usage']).toBe('node scripts/radicale-usage.mjs')
  })
})
