// @vitest-environment node
//
// The CalDAV gateway against the real test stack: Kanidm tokens, the app's Nitro server and
// Radicale. Skipped unless GATEWAY_IT=1.
//
// Setup (docs: dev/spike-s1/README.md):
//   1. Test stack running: `cd dev/spike-s1 && ./spike.sh up && ./spike.sh bootstrap`.
//   2. Reach it from the dev container: `docker network connect spike-s1_default <dev-container>`.
//   3. In the dev container, start the app with the stack's addresses and the test CA:
//        NUXT_OIDC_ISSUER=https://idm.localhost:8443/oauth2/openid/web-calendar \
//        NUXT_RADICALE_URL=http://radicale:5232 \
//        NUXT_TOKEN_HASH_KEY=test-key-test-key-test-key-test-key \
//        NODE_EXTRA_CA_CERTS=$PWD/dev/spike-s1/.local/certs/ca.crt \
//        npx nuxt dev --port 3100
//   4. Tokens live 15 minutes. Get them on the host (`./spike.sh token alice`, `... bob`) and pass
//      the access tokens and alice's ID token:
//        GATEWAY_IT=1 GATEWAY_URL=http://127.0.0.1:3100 \
//        ALICE_ACCESS_TOKEN=... ALICE_ID_TOKEN=... BOB_ACCESS_TOKEN=... \
//        npx vitest run tests/integration
//      Optional: ALICE_APP_TOKEN (an app token of the user `alice`, created in the app's database
//      for alice's `sub`) enables the Basic-auth checks.
//
// Against the PRODUCTION build, with a fake Radicale and a fake identity provider and no setup at
// all: `npm run test:gateway:prod` (scripts/test-gateway-prod.mjs). It sets these variables itself
// and also runs gateway-raw.integration.test.ts.
import { request } from 'node:http'
import { decodeJwt } from 'jose'
import { afterAll, describe, expect, it } from 'vitest'

const enabled = process.env.GATEWAY_IT === '1'
const base = new URL(process.env.GATEWAY_URL ?? 'http://127.0.0.1:3100')
const aliceToken = process.env.ALICE_ACCESS_TOKEN ?? ''
const aliceIdToken = process.env.ALICE_ID_TOKEN ?? ''
const bobToken = process.env.BOB_ACCESS_TOKEN ?? ''
const aliceAppToken = process.env.ALICE_APP_TOKEN ?? ''

const subOf = (token: string) => (token ? String(decodeJwt(token).sub) : '')
const aliceSub = subOf(aliceToken)
const bobSub = subOf(bobToken)

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * A request with the path exactly as given (`fetch` would resolve `..` before sending it), and
 * chunked encoding when the body has no declared length.
 */
function raw(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer | { chunks: string[] },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: base.hostname, port: base.port, method, path, headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (body && typeof body === 'object' && 'chunks' in body) {
      for (const chunk of body.chunks) req.write(chunk)
    } else if (body !== undefined) {
      req.write(body)
    }
    req.end()
  })
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const principal = (xml: string) => /<current-user-principal><href>([^<]*)/.exec(xml)?.[1]

function event(uid: string, summary: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-calendar gateway test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20301001T080000Z',
    'DTSTART:20301001T100000Z',
    'DTEND:20301001T110000Z',
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

describe.skipIf(!enabled)('CalDAV gateway against Kanidm and Radicale', () => {
  const home = `/caldav/${aliceSub}/`
  const calendar = `${home}def-calendar/`
  const created: string[] = []

  afterAll(async () => {
    for (const path of created) await raw('DELETE', path, bearer(aliceToken))
  })

  it('has tokens to work with', () => {
    expect(aliceSub).not.toBe('')
    expect(bobSub).not.toBe('')
    expect(aliceSub).not.toBe(bobSub)
    expect(aliceIdToken).not.toBe('')
  })

  describe('discovery and configuration', () => {
    it('redirects /.well-known/caldav to /caldav/ without credentials', async () => {
      for (const method of ['GET', 'HEAD', 'PROPFIND']) {
        const reply = await raw(method, '/.well-known/caldav')
        expect(reply.status).toBe(301)
        expect(reply.headers.location).toBe('/caldav/')
      }
      expect((await raw('POST', '/.well-known/caldav')).status).toBe(405)
    })

    it('serves the public OIDC values and nothing secret', async () => {
      const reply = await raw('GET', '/api/config')
      expect(reply.status).toBe(200)
      const config = JSON.parse(reply.body) as Record<string, unknown>
      expect(Object.keys(config).sort()).toEqual(['demo', 'oidc', 'signinWindowDays', 'timezone'])
      expect(config.demo).toBe(false)
      expect(Object.keys(config.oidc as object).sort()).toEqual(['clientId', 'issuer', 'scope'])
      expect(config.timezone).toBe(process.env.TZ || 'Europe/Berlin')
    })
  })

  describe('rejections', () => {
    it('answers 401 with both challenges when there is no credential', async () => {
      for (const path of ['/caldav', '/caldav/', home]) {
        const reply = await raw('PROPFIND', path, { depth: '0' })
        expect(reply.status).toBe(401)
        const challenge = String(reply.headers['www-authenticate'])
        expect(challenge).toContain('Basic realm="Web Calendar"')
        expect(challenge).toContain('Bearer realm="Web Calendar"')
      }
      expect((await raw('OPTIONS', '/caldav/')).status).toBe(401)
    })

    it('answers 401 for garbage, for a tampered token and for an ID token', async () => {
      const [header, payload, signature] = aliceToken.split('.')
      const tampered = `${header}.${payload}.${signature!.slice(0, -4)}AAAA`
      for (const token of ['garbage', 'a.b.c', tampered, aliceIdToken]) {
        const reply = await raw('PROPFIND', home, { ...bearer(token), depth: '0' })
        expect(reply.status).toBe(401)
        expect(String(reply.headers['www-authenticate'])).toContain('invalid_token')
      }
    })

    it('refuses other methods, traversal, double slashes and the sharing API', async () => {
      const auth = bearer(aliceToken)
      expect((await raw('POST', `${home}`, auth)).status).toBe(405)
      expect((await raw('POST', '/caldav/.sharing/v1/map/create', auth)).status).toBe(405)
      expect((await raw('PROPFIND', `${home}../${bobSub}/`, auth)).status).toBe(400)
      expect((await raw('PROPFIND', `${home}%2e%2e/${bobSub}/`, auth)).status).toBe(400)
      expect((await raw('PROPFIND', `/caldav//${bobSub}/`, auth)).status).toBe(400)
      expect((await raw('GET', `/caldav/${aliceSub}%2F..%2F${bobSub}/`, auth)).status).toBe(400)
      expect((await raw('PROPFIND', '/caldav/.sharing/v1/map/list', auth)).status).toBe(404)
    })

    it('answers 413 for a body over the limit', async () => {
      const reply = await raw('PUT', `${calendar}too-big.ics`, bearer(aliceToken), {
        chunks: Array.from({ length: 11 }, () => 'x'.repeat(1024 * 1024)),
      })
      expect(reply.status).toBe(413)
      // The body is not read to its end, so the answer must end the connection.
      expect(reply.headers.connection).toBe('close')
    })
  })

  describe('identity', () => {
    it('lets alice read her own principal', async () => {
      const reply = await raw('PROPFIND', home, { ...bearer(aliceToken), depth: '0' })
      expect(reply.status).toBe(207)
      expect(principal(reply.body)).toBe(home)
    })

    it('rewrites Radicale’s answers under /caldav/', async () => {
      const reply = await raw('PROPFIND', home, { ...bearer(aliceToken), depth: '1' })
      expect(reply.status).toBe(207)
      expect(reply.body).toContain(`<href>${calendar}</href>`)
    })

    it('ignores a spoofed X-Remote-User, X-Script-Name and X-Forwarded-*', async () => {
      const spoof = {
        ...bearer(aliceToken),
        'x-remote-user': bobSub,
        'x-script-name': '/evil',
        'x-forwarded-for': '10.1.2.3',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-user': bobSub,
        forwarded: 'for=10.1.2.3',
        depth: '0',
      }
      const own = await raw('PROPFIND', home, spoof)
      expect(own.status).toBe(207)
      expect(principal(own.body)).toBe(home)
      // Alice stays alice: bob’s home is still closed to her.
      expect((await raw('PROPFIND', `/caldav/${bobSub}/`, spoof)).status).toBe(403)
    })

    it('keeps users apart', async () => {
      const bobsHome = await raw('PROPFIND', `/caldav/${bobSub}/`, {
        ...bearer(bobToken),
        depth: '0',
      })
      expect(bobsHome.status).toBe(207)
      expect(principal(bobsHome.body)).toBe(`/caldav/${bobSub}/`)
      expect((await raw('PROPFIND', home, { ...bearer(bobToken), depth: '0' })).status).toBe(403)
      expect((await raw('GET', calendar, bearer(bobToken))).status).toBe(403)
    })

    it.skipIf(!aliceAppToken)(
      'accepts Basic with an app token and maps it to the owner',
      async () => {
        const basic = (user: string, token: string) => ({
          authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
          depth: '0',
        })
        const reply = await raw('PROPFIND', home, basic('alice', aliceAppToken))
        expect(reply.status).toBe(207)
        expect(principal(reply.body)).toBe(home)
        expect((await raw('PROPFIND', home, basic('alice', `${aliceAppToken}x`))).status).toBe(401)
        // A name used once per run: the gateway throttles repeated failures per user and address.
        const stranger = `nobody-${Date.now()}`
        expect((await raw('PROPFIND', home, basic(stranger, aliceAppToken))).status).toBe(401)
      },
    )
  })

  describe('an event through the gateway', () => {
    const name = `it-${Date.now()}`
    const uid = `${name}@gateway.test`

    it('creates, reads, queries, moves and deletes an event', async () => {
      const auth = bearer(aliceToken)
      const path = `${calendar}${name}.ics`
      created.push(path)

      const put = await raw(
        'PUT',
        path,
        { ...auth, 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
        event(uid, 'Gateway test'),
      )
      expect(put.status).toBe(201)
      expect(put.headers.etag).toBeTruthy()

      const get = await raw('GET', path, auth)
      expect(get.status).toBe(200)
      expect(get.body).toContain('SUMMARY:Gateway test')

      const report = await raw(
        'REPORT',
        calendar,
        { ...auth, 'content-type': 'application/xml; charset=utf-8', depth: '1' },
        `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="20301001T000000Z" end="20301002T000000Z"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`,
      )
      expect(report.status).toBe(207)
      expect(report.body).toContain(uid)

      const movedPath = `${calendar}${name}-moved.ics`
      created.push(movedPath)
      const move = await raw('MOVE', path, {
        ...auth,
        destination: `${base.origin}${movedPath}`,
        overwrite: 'F',
      })
      expect([201, 204]).toContain(move.status)
      expect((await raw('GET', path, auth)).status).toBe(404)
      expect((await raw('GET', movedPath, auth)).status).toBe(200)

      // A destination outside /caldav/ never reaches Radicale.
      const outside = await raw('MOVE', movedPath, {
        ...auth,
        destination: `${base.origin}/api/config`,
      })
      expect(outside.status).toBe(403)

      // Radicale answers a DELETE with 200 and a multistatus body.
      expect([200, 204]).toContain((await raw('DELETE', movedPath, auth)).status)
      expect((await raw('GET', movedPath, auth)).status).toBe(404)
    })

    it('stores a chunked upload completely (Radicale ignores chunked bodies)', async () => {
      const chunkedName = `${name}-chunked`
      const path = `${calendar}${chunkedName}.ics`
      created.push(path)
      const body = event(`${chunkedName}@gateway.test`, 'Chunked upload')
      const half = Math.floor(body.length / 2)
      const put = await raw(
        'PUT',
        path,
        { ...bearer(aliceToken), 'content-type': 'text/calendar; charset=utf-8' },
        { chunks: [body.slice(0, half), body.slice(half)] },
      )
      expect(put.status).toBe(201)
      const get = await raw('GET', path, bearer(aliceToken))
      expect(get.body).toContain('SUMMARY:Chunked upload')
      expect(get.body).toContain('END:VCALENDAR')
    })

    it('does not let bob touch alice’s calendar', async () => {
      const path = `${calendar}${name}-bob.ics`
      const put = await raw(
        'PUT',
        path,
        { ...bearer(bobToken), 'content-type': 'text/calendar', 'if-none-match': '*' },
        event(`${name}-bob@gateway.test`, 'Not allowed'),
      )
      expect(put.status).toBe(403)
      expect((await raw('GET', path, bearer(aliceToken))).status).toBe(404)
    })
  })
})
