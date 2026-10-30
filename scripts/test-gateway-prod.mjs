#!/usr/bin/env node
// The CalDAV gateway integration tests against the PRODUCTION build (security review test gap 4,
// backlog 15). The dev server is not what ships: it has its own Host allow-list and request path.
// This builds the app (`nuxt build`), starts `server/index.mjs` of the build on a free port with a
// fake Radicale and a fake identity provider that serves its signing keys, and runs
// tests/integration/gateway*.integration.test.ts against it. There is no CI configuration in the
// repository; run it wherever one is added:
//
//   npm run test:gateway:prod [-- --output <dir> | --skip-build] [--keep] [--verbose]
//
// The build goes into a temporary directory, with its own Nuxt build directory: `.output` and
// `.nuxt`, which a dev server or a `npm run build` of somebody else may be using, stay untouched.
// This works through `nuxt build --extends <layer>`: the layer is a one-file Nuxt config written to
// the temporary directory that sets `buildDir` and `nitro.output.dir`. If a Nuxt upgrade stops
// honouring that, the script fails in the build step; run `nuxt build` yourself (it then overwrites
// `.output`) and pass `--skip-build`, or `--output <dir>` for a build somewhere else.
//
//   --output <dir>   test the build in <dir> (it must hold server/index.mjs); no build
//   --skip-build     same for ./.output
//   --keep           keep the temporary directory (the build, the database) afterwards
//   --verbose        print the server's output as it comes, not only after a failure
//
// What the fakes are: the fake Radicale (scripts/lib/fake-radicale.mjs) answers like Radicale 3.9
// for the requests of the test and records what reaches it; the fake identity provider
// (scripts/lib/fake-idp.mjs) generates an ES256 key per run, publishes it at
// `<issuer>/public_key.jwk` like Kanidm, answers `userinfo` and signs tokens for alice and bob. The
// app token for the Basic-auth tests is made through the app's own API, so the build's database
// and API are exercised too. The server is started with only the environment this script gives it.
//
// After the build it also checks that the dev-only packages of the advisory in the README ("Known
// issues": node-forge, reached through listhen) are not in the output (security review §8).
//
// Exit codes: 0 all passed, 1 a test or the output check failed, 2 the run could not be set up.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startFakeIdp } from './lib/fake-idp.mjs'
import { startFakeRadicale } from './lib/fake-radicale.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The children that are running, so a signal to this script can reach them. */
const running = new Set()
/** @param {import('node:child_process').ChildProcess} child */
function track(child) {
  running.add(child)
  child.once('exit', () => running.delete(child))
  return child
}

/** The suites that need a running gateway; each skips itself without GATEWAY_IT=1. */
export const TEST_FILES = [
  'tests/integration/gateway.integration.test.ts',
  'tests/integration/gateway-raw.integration.test.ts',
]
/** Packages of the accepted advisory that must not be part of the production server. */
export const DEV_ONLY_PACKAGES = ['node-forge', 'listhen']

export const USAGE =
  'Usage: node scripts/test-gateway-prod.mjs [--output <dir> | --skip-build] [--keep] [--verbose]'

/**
 * @typedef {{ output: string | null, keep: boolean, verbose: boolean }} Options
 * @param {string[]} argv the arguments after the script name
 * @returns {{ options: Options } | { error: string }}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { output: null, keep: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep') options.keep = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--skip-build') options.output = options.output ?? '.output'
    else if (arg === '--output') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--'))
        return { error: '--output needs a directory' }
      options.output = value
    } else return { error: `unknown argument ${arg}` }
  }
  return { options }
}

/**
 * The one-file Nuxt layer that moves the build: its own `.nuxt` and its own Nitro output.
 * @param {string} buildDir
 * @param {string} outputDir
 * @returns {string}
 */
export function layerSource(buildDir, outputDir) {
  return `export default ${JSON.stringify({ buildDir, nitro: { output: { dir: outputDir } } }, null, 2)}\n`
}

/**
 * The environment of the server under test: nothing from the caller's shell (a stray NUXT_DEMO or
 * NUXT_GATEWAY_* would change what is tested) but PATH.
 * @param {{ port: number, issuer: string, radicaleUrl: string, dbPath: string, hashKey: string }}
 *   settings
 * @returns {Record<string, string>}
 */
export function serverEnv(settings) {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(settings.port),
    TZ: 'Europe/Berlin',
    NUXT_OIDC_ISSUER: settings.issuer,
    NUXT_RADICALE_URL: settings.radicaleUrl,
    NUXT_TOKEN_HASH_KEY: settings.hashKey,
    NUXT_DB_PATH: settings.dbPath,
  }
}

/** @param {string} dir @returns {string[]} the .mjs files below dir, without node_modules */
function bundleFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : bundleFiles(path)
    return entry.name.endsWith('.mjs') ? [path] : []
  })
}

/**
 * Looks at a build output: it must hold the server, and the packages of the accepted advisory must
 * not be in `server/node_modules`. A mention in the bundle is no proof of use (a comment, a
 * message), so it is only reported.
 * @param {string} outputDir
 * @returns {{ problems: string[], notes: string[] }}
 */
export function checkOutput(outputDir) {
  const server = join(outputDir, 'server')
  /** @type {string[]} */
  const problems = []
  /** @type {string[]} */
  const notes = []
  if (!existsSync(join(server, 'index.mjs'))) {
    problems.push(`${join(server, 'index.mjs')} does not exist: there is no production build there`)
    return { problems, notes }
  }
  for (const name of DEV_ONLY_PACKAGES) {
    if (existsSync(join(server, 'node_modules', name))) {
      problems.push(`the production server contains ${name} (server/node_modules/${name})`)
    }
  }
  const files = bundleFiles(server)
  for (const name of DEV_ONLY_PACKAGES) {
    const mentions = files.filter((file) => readFileSync(file, 'utf8').includes(name))
    if (mentions.length > 0) {
      notes.push(
        `${name} is mentioned in ${mentions.length} bundle file(s), for example ${mentions[0]}; ` +
          'check whether it is loaded',
      )
    }
  }
  return { problems, notes }
}

/** A port nobody listens on (a small race remains between closing it and the server's bind). */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address())
      probe.close(() => resolvePort(port))
    })
  })
}

/**
 * Polls a URL until it answers 200.
 * @param {string} url
 * @param {{ timeoutMs?: number, intervalMs?: number, failed?: () => string | null }} [options]
 *   `failed` returns a reason once waiting is pointless (the server exited)
 */
export async function waitForUrl(url, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  for (;;) {
    const reason = options.failed?.()
    if (reason) throw new Error(reason)
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status === 200) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) throw new Error(`${url} did not answer 200 in time`)
    await new Promise((resolveWait) => setTimeout(resolveWait, options.intervalMs ?? 200))
  }
}

/**
 * Runs a program with the output passed through; resolves with its exit code.
 * @param {string[]} args node arguments
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {Promise<number>}
 */
function runNode(args, options) {
  return new Promise((resolveRun, reject) => {
    const child = track(spawn(process.execPath, args, { stdio: 'inherit', ...options }))
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)))
  })
}

/**
 * Stops a child: SIGTERM, then SIGKILL after a grace period.
 * @param {import('node:child_process').ChildProcess} child
 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}

/**
 * Makes alice's app token through the app itself: the first `/api/me` creates her user row and
 * stores her user name from the fake userinfo, which the Basic login is looked up by.
 * @param {string} base
 * @param {string} accessToken
 */
async function createAppToken(base, accessToken) {
  const headers = { authorization: `Bearer ${accessToken}` }
  const me = await fetch(`${base}/api/me`, { headers })
  if (me.status !== 200) throw new Error(`GET /api/me answered ${me.status}`)
  // Without the user name the Basic tests would fail with a 401 that says nothing about why.
  const { username } = /** @type {{ username: string | null }} */ (await me.json())
  if (username !== 'alice') {
    throw new Error(
      `GET /api/me returned the user name ${JSON.stringify(username)}, not "alice": did the ` +
        'server reach the fake identity provider (userinfo)?',
    )
  }
  const created = await fetch(`${base}/api/app-tokens`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'gateway-prod-test' }),
  })
  if (created.status !== 201) throw new Error(`POST /api/app-tokens answered ${created.status}`)
  return /** @type {{ token: string }} */ (await created.json()).token
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`)
    return 2
  }
  const { options } = parsed
  const log = (/** @type {string} */ message) => console.log(`[gateway-prod] ${message}`)

  const work = mkdtempSync(join(tmpdir(), 'wcal-gateway-prod-'))
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let server
  /** @type {Awaited<ReturnType<typeof startFakeIdp>> | undefined} */
  let idp
  /** @type {Awaited<ReturnType<typeof startFakeRadicale>> | undefined} */
  let radicale
  /** @type {string[]} */
  const serverLog = []
  /** @type {number} */
  let code
  try {
    const outputDir = options.output ? resolve(root, options.output) : join(work, 'output')
    if (!options.output) {
      log(`building into ${outputDir} (Nuxt build directory ${join(work, 'nuxt')})`)
      mkdirSync(join(work, 'layer'))
      writeFileSync(
        join(work, 'layer', 'nuxt.config.mjs'),
        layerSource(join(work, 'nuxt'), outputDir),
      )
      const built = await runNode(
        [join(root, 'node_modules/.bin/nuxt'), 'build', '--extends', join(work, 'layer')],
        { cwd: root, env: { ...process.env, NODE_ENV: 'production' } },
      )
      if (built !== 0) throw new Error(`nuxt build failed (exit ${built})`)
    }
    const output = checkOutput(outputDir)
    for (const note of output.notes) log(`note: ${note}`)
    for (const problem of output.problems) console.error(`[gateway-prod] FAIL: ${problem}`)
    if (!existsSync(join(outputDir, 'server', 'index.mjs'))) return 2

    idp = await startFakeIdp()
    radicale = await startFakeRadicale()
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    log(`starting ${join(outputDir, 'server/index.mjs')} on ${base}`)
    const child = track(
      spawn(process.execPath, [join(outputDir, 'server/index.mjs')], {
        cwd: work,
        env: serverEnv({
          port,
          issuer: idp.issuer,
          radicaleUrl: radicale.url,
          dbPath: join(work, 'web-calendar.db'),
          hashKey: randomBytes(32).toString('base64'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    server = child
    const collect = (/** @type {Buffer} */ chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        serverLog.push(line)
        if (options.verbose) console.log(`[server] ${line}`)
      }
      serverLog.splice(0, Math.max(0, serverLog.length - 200))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    await waitForUrl(`${base}/api/config`, {
      failed: () => (child.exitCode === null ? null : `the server exited with ${child.exitCode}`),
    })

    const { alice, bob } = idp.users
    const aliceToken = await idp.mint(alice)
    const env = {
      ...process.env,
      TZ: 'Europe/Berlin',
      GATEWAY_IT: '1',
      GATEWAY_URL: base,
      ALICE_ACCESS_TOKEN: aliceToken,
      ALICE_ID_TOKEN: await idp.mint(alice, { idToken: true }),
      BOB_ACCESS_TOKEN: await idp.mint(bob),
      ALICE_APP_TOKEN: await createAppToken(base, aliceToken),
      FAKE_RADICALE_CONTROL_URL: radicale.controlUrl,
    }
    log(`running ${TEST_FILES.join(', ')}`)
    const tests = await runNode([join(root, 'node_modules/.bin/vitest'), 'run', ...TEST_FILES], {
      cwd: root,
      env,
    })
    code = tests === 0 && output.problems.length === 0 ? 0 : 1
  } catch (error) {
    console.error(`[gateway-prod] ${error instanceof Error ? error.message : String(error)}`)
    if (!options.verbose && serverLog.length > 0) {
      console.error(`[gateway-prod] the server's last output:\n${serverLog.join('\n')}`)
    }
    code = 2
  } finally {
    if (server) await stopChild(server)
    await Promise.all([idp?.close(), radicale?.close()])
    if (options.keep) log(`kept ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
  return code
}

// Run as a script; importing the module has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pass a signal on to the build, the server and the tests; `main` then ends and cleans up.
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.once(signal, () => {
      for (const child of running) child.kill(signal)
      setTimeout(() => process.exit(130), 10_000).unref()
    })
  }
  process.exitCode = await main(process.argv.slice(2))
}
