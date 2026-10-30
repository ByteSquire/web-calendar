// Spike (design S8, "does tsdav work in the browser"): the CalDAV transport of app/utils/caldav,
// with tsdav and its xml-js dependency, bundled the way the SPA is (esbuild, platform browser, so
// tsdav's "browser" export is used) and run in a REAL Chromium and WebKit page against the gateway.
//
// The page is a blank one served by Playwright at <gateway>/__smoke, so requests to /caldav are
// same-origin with the real gateway, as in the SPA. In the page: discover, listCalendars, a scratch
// calendar with one event, fetchObjects with and without expand, a stale-ETag write (412), an
// abort, and cleanup. Run in the dev container with the gateway up and a fresh token (15 min):
//
//   ALICE_ACCESS_TOKEN=... GATEWAY_URL=http://127.0.0.1:3300 \
//     node dev/spike-tscaldav/browser-smoke.mjs [chromium] [webkit]
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, webkit } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const caldavIndex = resolve(repo, 'app/utils/caldav/index.ts')
const origin = new URL(process.env.GATEWAY_URL ?? 'http://127.0.0.1:3300').origin
const token = process.env.ALICE_ACCESS_TOKEN
if (!token) {
  console.error('ALICE_ACCESS_TOKEN is required')
  process.exit(2)
}

// What runs in the page. Everything it returns is plain JSON.
const smoke = `
import { createCalDavClient, createCalendarReader, DavError } from ${JSON.stringify(caldavIndex)}

const ics = (uid, summary, extra = []) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//smoke//EN', 'BEGIN:VEVENT', 'UID:' + uid,
   'DTSTAMP:20261001T000000Z', 'SUMMARY:' + summary, 'DTSTART:20261105T100000Z',
   'DTEND:20261105T110000Z', ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\\r\\n')

const kind = async (promise) => {
  try { await promise; return 'resolved' } catch (e) { return e instanceof DavError ? e.kind : 'other:' + e }
}

window.__smoke = async (accessToken) => {
  const out = { steps: {}, errors: [] }
  let client, scratch
  try {
    client = createCalDavClient({
      baseUrl: location.origin + '/caldav',
      fetch: (input, init) => {
        const headers = new Headers(init && init.headers)
        headers.set('Authorization', 'Bearer ' + accessToken)
        return fetch(input, { ...init, headers })
      },
    })
    out.steps.discover = await client.discover()
    out.steps.calendars = (await client.listCalendars()).map((c) => [c.displayName, c.color, c.readOnly])
    scratch = await client.createCalendar({ displayName: 'Smoke <&> test', color: '#336699' })
    const created = await client.putObject({
      url: scratch.url + 'a.ics', data: ics('smoke-a', 'Caf\\u00e9 \\u2713 & <x>', ['RRULE:FREQ=DAILY;COUNT=3']), create: true,
    })
    out.steps.createdEtag = created.etag
    const range = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-30T00:00:00Z') }
    const raw = await client.fetchObjects(scratch.url, range)
    out.steps.raw = raw.map((o) => ({ etag: o.etag, hasRrule: o.data.includes('RRULE'), summary: /SUMMARY:(.*)/.exec(o.data)?.[1]?.trim() }))
    const expanded = await client.fetchObjects(scratch.url, range, { expand: true })
    out.steps.expanded = { objects: expanded.length, instances: (expanded[0]?.data.match(/BEGIN:VEVENT/g) ?? []).length, hasRrule: expanded[0]?.data.includes('RRULE') }
    const saved = await client.putObject({ url: scratch.url + 'a.ics', data: raw[0].data.replace('Caf', 'Edited caf'), etag: created.etag })
    out.steps.updatedEtagChanged = saved.etag !== created.etag
    out.steps.staleWrite = await kind(client.putObject({ url: scratch.url + 'a.ics', data: raw[0].data, etag: created.etag }))
    out.steps.createAgain = await kind(client.putObject({ url: scratch.url + 'a.ics', data: raw[0].data, create: true }))
    const controller = new AbortController()
    const pending = kind(client.fetchObjects(scratch.url, range, { signal: controller.signal }))
    controller.abort()
    out.steps.abort = await pending
    out.steps.badToken = await kind(createCalDavClient({
      baseUrl: location.origin + '/caldav',
      fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init && init.headers)), Authorization: 'Bearer nope' } }),
    }).discover())
    const results = await createCalendarReader(client).read(
      [{ url: scratch.url, expand: false }, { url: scratch.url.replace(/[^/]+\\/$/, 'missing/'), expand: false }], range)
    out.steps.reader = results.map((r) => r.error ? 'error:' + r.error.kind : 'objects:' + r.objects.length)
    await client.deleteObject(scratch.url + 'a.ics', saved.etag)
  } catch (e) {
    out.errors.push(String(e && e.stack || e))
  } finally {
    if (client && scratch) {
      try { await client.deleteObject(scratch.url); out.steps.cleanup = 'done' } catch (e) { out.errors.push('cleanup: ' + e) }
    }
  }
  return out
}
`

// One bundle of the library alone, for the size figures (the global keeps it from being shaken out).
const library = `
import { createCalDavClient, createCalendarReader } from ${JSON.stringify(caldavIndex)}
globalThis.__lib = { createCalDavClient, createCalendarReader }
`

async function bundle(contents) {
  const result = await build({
    stdin: { contents, resolveDir: repo, loader: 'ts', sourcefile: 'smoke-entry.ts' },
    bundle: true,
    write: false,
    platform: 'browser', // picks tsdav's "browser" export (dist/tsdav.js, xml-js and debug inlined)
    format: 'iife',
    target: 'es2022',
    minify: true,
    metafile: true,
    logLevel: 'warning',
  })
  const code = result.outputFiles[0].text
  const inputs = Object.keys(result.metafile.inputs)
  return { code, inputs, outputs: result.metafile.outputs }
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`
const lib = await bundle(library)
const full = await bundle(smoke)
const tsdavFiles = full.inputs.filter((f) => f.includes('node_modules/tsdav/'))
const otherModules = full.inputs.filter(
  (f) => f.includes('node_modules/') && !f.includes('node_modules/tsdav/'),
)
const bytesBy = (needle) =>
  Object.values(lib.outputs)[0] &&
  Object.entries(Object.values(lib.outputs)[0].inputs)
    .filter(([file]) => file.includes(needle))
    .reduce((sum, [, info]) => sum + info.bytesInOutput, 0)

console.log('== bundle (esbuild, platform browser, minified)')
console.log(`library only: ${kb(lib.code.length)} raw, ${kb(gzipSync(lib.code).length)} gzip`)
console.log(
  `  of which tsdav (with xml-js and debug inlined): ${kb(bytesBy('node_modules/tsdav/'))} raw`,
)
console.log(`  of which app/utils/caldav: ${kb(bytesBy('app/utils/caldav/'))} raw`)
console.log(
  `with the smoke code: ${kb(full.code.length)} raw, ${kb(gzipSync(full.code).length)} gzip`,
)
console.log(`tsdav files bundled: ${tsdavFiles.join(', ')}`)
console.log(`other node_modules bundled: ${otherModules.length ? otherModules.join(', ') : 'none'}`)

const launchers = { chromium, webkit }
const wanted = process.argv.slice(2).filter((n) => n in launchers)
let failed = false
for (const name of wanted.length ? wanted : ['chromium', 'webkit']) {
  console.log(`\n== ${name}`)
  const browser = await launchers[name].launch()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const problems = []
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`))
    page.on('requestfailed', (r) =>
      problems.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`),
    )
    // A blank page on the gateway's own origin: /caldav stays same-origin and reaches the real gateway.
    await page.route(`${origin}/__smoke`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>smoke</title><body>blank</body>',
      }),
    )
    await page.goto(`${origin}/__smoke`)
    await page.addScriptTag({ content: full.code })
    const out = await page.evaluate((accessToken) => window.__smoke(accessToken), token)
    console.log(JSON.stringify(out.steps, null, 2))
    if (out.errors.length) console.log('errors in page:', out.errors)
    // The 412, 401 and 404 console lines and the cancelled REPORT are the deliberate cases above.
    if (problems.length) console.log('browser console and network notes:', problems)
    if (pageErrors.length) console.log('uncaught errors in the page:', pageErrors)
    const s = out.steps
    const ok =
      out.errors.length === 0 &&
      pageErrors.length === 0 &&
      s.discover?.homeUrl &&
      s.raw?.length === 1 &&
      s.raw[0].hasRrule &&
      s.expanded?.instances === 3 &&
      s.expanded.hasRrule === false &&
      s.updatedEtagChanged === true &&
      s.staleWrite === 'conflict' &&
      s.createAgain === 'exists' &&
      s.abort === 'aborted' &&
      s.badToken === 'unauthorized' &&
      s.reader?.join() === 'objects:1,error:not-found' &&
      s.cleanup === 'done'
    console.log(ok ? `${name}: OK` : `${name}: FAILED`)
    if (!ok) failed = true
  } finally {
    await browser.close()
  }
}
process.exit(failed ? 1 : 0)
