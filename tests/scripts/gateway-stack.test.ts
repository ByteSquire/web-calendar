// @vitest-environment node
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeIdp } from '../../scripts/lib/fake-idp.mjs'
import { startGatewayStack, type GatewayStack } from './gateway-stack'

// The fake identity provider and the fake Radicale of scripts/test-gateway-prod.mjs, tested against
// the real gateway, token verifier and app-token code over HTTP: what tests/integration/
// gateway.integration.test.ts expects of the stack it runs against, checked without a build.

let stack: GatewayStack
let aliceToken: string
let bobToken: string

beforeAll(async () => {
  stack = await startGatewayStack()
  aliceToken = await stack.idp.mint(stack.alice)
  bobToken = await stack.idp.mint(stack.bob)
})

afterAll(async () => {
  await stack.close()
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const home = () => `/caldav/${stack.alice.sub}/`
const calendar = () => `${home()}def-calendar/`
const principal = (xml: string) => /<current-user-principal><href>([^<]*)/.exec(xml)?.[1]

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return fetch(`${stack.base}${path}`, { method, headers, body })
}

function event(uid: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//gateway stack test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20301001T080000Z',
    'DTSTART:20301001T100000Z',
    'DTEND:20301001T110000Z',
    'SUMMARY:Stack test',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

describe('the fake identity provider', () => {
  it('publishes its key like Kanidm: the same JWK fields, an ES256 signing key with an id', async () => {
    const published = (await (await fetch(`${stack.idp.issuer}/public_key.jwk`)).json()) as {
      keys: Record<string, string>[]
    }
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../server/auth-kanidm-fixture.json', import.meta.url)),
        'utf8',
      ),
    ) as { jwks: { keys: Record<string, string>[] } }
    expect(published.keys).toHaveLength(1)
    expect(Object.keys(published.keys[0]!).sort()).toEqual(
      Object.keys(fixture.jwks.keys[0]!).sort(),
    )
    expect(published.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })
    expect(published.keys[0]!.kid).toBe(stack.idp.kid)
  })

  it('signs tokens the production verifier accepts, and only those', async () => {
    expect((await call('PROPFIND', home(), { ...bearer(aliceToken), depth: '0' })).status).toBe(207)

    // An ID token has no `typ: at+jwt`.
    const idToken = await stack.idp.mint(stack.alice, { idToken: true })
    const idReply = await call('PROPFIND', home(), bearer(idToken))
    expect(idReply.status).toBe(401)
    expect(idReply.headers.get('www-authenticate')).toContain('invalid_token')

    // Another run's key: same kid shape, other key, same issuer name is not enough.
    const other = await startFakeIdp()
    try {
      const forged = await other.mint(stack.alice)
      expect((await call('PROPFIND', home(), bearer(forged))).status).toBe(401)
    } finally {
      await other.close()
    }
  })

  it('answers userinfo only for a token it signed, about that token’s subject', async () => {
    const answer = await fetch(`${stack.idp.issuer}/userinfo`, { headers: bearer(aliceToken) })
    expect(await answer.json()).toMatchObject({
      sub: stack.alice.sub,
      preferred_username: 'alice',
      groups: ['web_calendar_users'],
    })
    expect(
      (await fetch(`${stack.idp.issuer}/userinfo`, { headers: bearer('garbage') })).status,
    ).toBe(401)
    expect((await fetch(`${stack.idp.issuer}/userinfo`)).status).toBe(401)
  })
})

describe('the fake Radicale behind the gateway', () => {
  it('lists the principal and the calendar of the caller, under /caldav/', async () => {
    const own = await call('PROPFIND', home(), { ...bearer(aliceToken), depth: '0' })
    expect(own.status).toBe(207)
    expect(principal(await own.text())).toBe(home())
    const listing = await call('PROPFIND', home(), { ...bearer(aliceToken), depth: '1' })
    expect(await listing.text()).toContain(`<href>${calendar()}</href>`)
  })

  it('keeps users apart: 403 for every method on another user’s path, nothing created', async () => {
    const closed = await call('PROPFIND', `/caldav/${stack.bob.sub}/`, {
      ...bearer(aliceToken),
      depth: '0',
    })
    expect(closed.status).toBe(403)
    expect((await call('GET', calendar(), bearer(bobToken))).status).toBe(403)
    const put = await call(
      'PUT',
      `${calendar()}by-bob.ics`,
      { ...bearer(bobToken), 'content-type': 'text/calendar', 'if-none-match': '*' },
      event('by-bob@stack.test'),
    )
    expect(put.status).toBe(403)
    expect((await call('GET', `${calendar()}by-bob.ics`, bearer(aliceToken))).status).toBe(404)
  })

  it('ignores a spoofed X-Remote-User: the gateway sets the identity, not the client', async () => {
    const reply = await call('PROPFIND', home(), {
      ...bearer(aliceToken),
      'x-remote-user': stack.bob.sub,
      depth: '0',
    })
    expect(principal(await reply.text())).toBe(home())
  })

  it('creates, reads, queries, moves and deletes an event, as Radicale answers', async () => {
    const auth = bearer(aliceToken)
    const path = `${calendar()}flow.ics`
    const put = await call(
      'PUT',
      path,
      { ...auth, 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
      event('flow@stack.test'),
    )
    expect(put.status).toBe(201)
    expect(put.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
    // `If-None-Match: *` on an existing object.
    const again = await call(
      'PUT',
      path,
      { ...auth, 'content-type': 'text/calendar', 'if-none-match': '*' },
      event('flow@stack.test'),
    )
    expect(again.status).toBe(412)

    const get = await call('GET', path, auth)
    expect(get.status).toBe(200)
    expect(await get.text()).toContain('SUMMARY:Stack test')

    const report = await call(
      'REPORT',
      calendar(),
      { ...auth, 'content-type': 'application/xml', depth: '1' },
      '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"/>',
    )
    expect(report.status).toBe(207)
    expect(await report.text()).toContain('UID:flow@stack.test')

    const move = await call('MOVE', path, {
      ...auth,
      destination: `${stack.base}${calendar()}flow-moved.ics`,
      overwrite: 'F',
    })
    expect(move.status).toBe(201)
    expect((await call('GET', path, auth)).status).toBe(404)
    // Into another user’s home is refused, and the object stays where it is.
    const away = await call('MOVE', `${calendar()}flow-moved.ics`, {
      ...auth,
      destination: `${stack.base}/caldav/${stack.bob.sub}/def-calendar/stolen.ics`,
    })
    expect(away.status).toBe(403)

    const deleted = await call('DELETE', `${calendar()}flow-moved.ics`, auth)
    expect(deleted.status).toBe(200)
    expect(await deleted.text()).toContain('HTTP/1.1 200 OK')
    expect((await call('GET', `${calendar()}flow-moved.ics`, auth)).status).toBe(404)
  })

  it('stores a body that arrives chunked completely, because the gateway sets the length', async () => {
    const body = event('chunked@stack.test')
    const half = Math.floor(body.length / 2)
    await new Promise<void>((resolve, reject) => {
      const req = request(
        `${stack.base}${calendar()}chunked.ics`,
        { method: 'PUT', headers: { ...bearer(aliceToken), 'content-type': 'text/calendar' } },
        (response) => {
          response.resume()
          expect(response.statusCode).toBe(201)
          response.on('end', resolve)
        },
      )
      req.on('error', reject)
      req.write(body.slice(0, half))
      req.end(body.slice(half))
    })
    const stored = await call('GET', `${calendar()}chunked.ics`, bearer(aliceToken))
    expect(await stored.text()).toBe(body)
  })

  it('creates a calendar with MKCALENDAR, and refuses to create it twice', async () => {
    const path = `${home()}made-by-test/`
    expect((await call('MKCALENDAR', path, bearer(aliceToken))).status).toBe(201)
    expect((await call('MKCALENDAR', path, bearer(aliceToken))).status).toBe(405)
    expect((await call('DELETE', path, bearer(aliceToken))).status).toBe(200)
  })

  it('accepts Basic with the app token of the owner and with nothing else', async () => {
    const basic = (user: string, token: string) => ({
      authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
      depth: '0',
    })
    const ok = await call('PROPFIND', home(), basic('alice', stack.aliceAppToken))
    expect(ok.status).toBe(207)
    expect(principal(await ok.text())).toBe(home())
    expect((await call('PROPFIND', home(), basic('alice', `${stack.aliceAppToken}x`))).status).toBe(
      401,
    )
    expect((await call('PROPFIND', home(), basic('bob', stack.aliceAppToken))).status).toBe(401)
  })

  it('answers 413 for a declared length over the limit, without asking Radicale', async () => {
    await fetch(stack.radicale.controlUrl, { method: 'DELETE' })
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${stack.base}${calendar()}too-big.ics`,
        {
          method: 'PUT',
          headers: {
            ...bearer(aliceToken),
            connection: 'close',
            'content-length': String(11 * 1024 * 1024),
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode!)
          req.destroy()
        },
      )
      req.on('error', reject)
      // The headers alone are enough; the body is never sent.
      req.flushHeaders()
    })
    expect(status).toBe(413)
    expect(await (await fetch(stack.radicale.controlUrl)).json()).toEqual([])
  })
})

describe('the fake Radicale’s record', () => {
  it('lists what reached it, with the user the gateway named, and forgets on DELETE', async () => {
    await fetch(stack.radicale.controlUrl, { method: 'DELETE' })
    await call('PROPFIND', `${home()}record-test/`, { ...bearer(aliceToken), depth: '0' })
    const seen = (await (await fetch(stack.radicale.controlUrl)).json()) as {
      method: string
      url: string
      user: string
    }[]
    expect(seen).toEqual([
      { method: 'PROPFIND', url: `/${stack.alice.sub}/record-test/`, user: stack.alice.sub },
    ])
    await fetch(stack.radicale.controlUrl, { method: 'DELETE' })
    expect(await (await fetch(stack.radicale.controlUrl)).json()).toEqual([])
  })

  it('is not reachable through the gateway: the control port is another server', async () => {
    const reply = await call('GET', `${home()}__fake/seen`, bearer(aliceToken))
    expect(reply.status).toBe(404)
  })
})

describe('the public config of the stand-in server', () => {
  it('has the shape of /api/config and redirects the well-known URL', async () => {
    const config = (await (await call('GET', '/api/config')).json()) as Record<string, unknown>
    expect(Object.keys(config).sort()).toEqual(['demo', 'oidc', 'timezone'])
    const redirect = await fetch(`${stack.base}/.well-known/caldav`, { redirect: 'manual' })
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('/caldav/')
  })
})
