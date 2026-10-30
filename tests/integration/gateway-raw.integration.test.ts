// @vitest-environment node
//
// The Node-level front of the gateway, with raw sockets: request shapes that `fetch` and
// `http.request` do not send (absolute-form targets, a doubled slash, conflicting framing headers,
// huge headers) and that decide whether the gateway sees a request at all (security review test
// gap 4). Skipped unless GATEWAY_IT=1; the setup and the tokens are those of
// gateway.integration.test.ts, and `npm run test:gateway:prod` runs both against the production
// build. Which statuses these shapes get from the layers in front of the gateway (the Node parser,
// Nitro's router) is pinned where the layer is fixed: Node answers 400 or 431 itself. Where Nitro's
// router decides (the SPA shell or a 404) the test asserts what matters: no multistatus, and no
// request reached Radicale. The second needs FAKE_RADICALE_CONTROL_URL, the record of the fake
// Radicale of the production run; against the real stack that check is skipped.
import { connect } from 'node:net'
import { decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'

const enabled = process.env.GATEWAY_IT === '1'
const base = new URL(process.env.GATEWAY_URL ?? 'http://127.0.0.1:3100')
const aliceToken = process.env.ALICE_ACCESS_TOKEN ?? ''
const control = process.env.FAKE_RADICALE_CONTROL_URL ?? ''
const aliceSub = aliceToken ? String(decodeJwt(aliceToken).sub) : ''

interface Reply {
  status: number
  head: string
  body: string
}

/** Sends the text as it is and reads until the server closes the connection. */
function exchange(text: string, timeoutMs = 5000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: base.hostname, port: Number(base.port) })
    const chunks: Buffer[] = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      const reply = Buffer.concat(chunks).toString('latin1')
      const [head = '', ...rest] = reply.split('\r\n\r\n')
      resolve({
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0),
        head,
        body: rest.join('\r\n\r\n'),
      })
    }
    const timer = setTimeout(finish, timeoutMs)
    socket.on('connect', () => socket.write(text))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('close', finish)
    socket.on('error', (error) => {
      if (!done) reject(error)
    })
  })
}

/** A request from the given lines (the request line first), `Connection: close`, a blank line. */
function lines(...parts: string[]): string {
  return [...parts, 'Connection: close', '', ''].join('\r\n')
}

const host = `Host: ${base.host}`
const auth = `Authorization: Bearer ${aliceToken}`

/** The paths that reached the fake Radicale, or null when there is no record to ask. */
async function reachedRadicale(): Promise<string[] | null> {
  if (!control) return null
  const seen = (await (await fetch(control)).json()) as { url: string }[]
  return seen.map((entry) => entry.url)
}

async function expectNotForwarded(marker: string): Promise<void> {
  const reached = await reachedRadicale()
  if (reached) expect(reached.filter((url) => url.includes(marker))).toEqual([])
}

describe.skipIf(!enabled)('the gateway behind raw sockets', () => {
  it('has a token to work with', () => {
    expect(aliceSub).not.toBe('')
  })

  it.skipIf(!control)(
    'records what reaches Radicale (so the checks below are not vacuous)',
    async () => {
      const marker = 'raw-control-marker'
      const reply = await exchange(
        lines(`PROPFIND /caldav/${aliceSub}/${marker}/ HTTP/1.1`, host, auth, 'Depth: 0'),
      )
      expect(reply.status).toBe(404)
      expect(await reachedRadicale()).toContain(`/${aliceSub}/${marker}/`)
    },
  )

  describe('targets that are not an origin-form path', () => {
    it('does not route an absolute-form target to the gateway', async () => {
      const marker = 'raw-absolute-form'
      const reply = await exchange(
        lines(
          `PROPFIND http://evil.example/caldav/${aliceSub}/${marker}/ HTTP/1.1`,
          'Host: evil.example',
          auth,
          'Depth: 0',
        ),
      )
      expect([200, 400, 404]).toContain(reply.status)
      expect(reply.body).not.toContain('multistatus')
      expect(reply.head.toLowerCase()).not.toContain('\r\ndav:')
      await expectNotForwarded(marker)
    })

    it('does not route a doubled slash in front of /caldav/ to the gateway', async () => {
      const marker = 'raw-double-slash'
      const reply = await exchange(
        lines(`PROPFIND //caldav/${aliceSub}/${marker}/ HTTP/1.1`, host, auth, 'Depth: 0'),
      )
      expect([200, 400, 404]).toContain(reply.status)
      expect(reply.body).not.toContain('multistatus')
      await expectNotForwarded(marker)
    })

    it.each([
      ['a dot segment', (marker: string) => `/caldav/${aliceSub}/../${marker}/`, 400],
      ['an encoded dot segment', (marker: string) => `/caldav/${aliceSub}/%2e%2e/${marker}/`, 400],
      ['an encoded NUL', (marker: string) => `/caldav/${aliceSub}/${marker}%00`, 400],
      ['an encoded line break', (marker: string) => `/caldav/${aliceSub}/${marker}%0d%0a`, 400],
      ['a raw space', (marker: string) => `/caldav/${aliceSub}/${marker} x`, 400],
    ])('refuses %s in the path before Radicale is asked', async (_name, path, status) => {
      const marker = `raw-path-${status}-${Math.random().toString(36).slice(2, 8)}`
      const reply = await exchange(
        lines(`PROPFIND ${path(marker)} HTTP/1.1`, host, auth, 'Depth: 0'),
      )
      expect(reply.status).toBe(status)
      await expectNotForwarded(marker)
    })

    it('hands `..;` on as an ordinary name below the caller’s own home, not as a traversal', async () => {
      const marker = 'raw-semicolon-dots'
      const reply = await exchange(
        lines(`PROPFIND /caldav/${aliceSub}/..;/${marker} HTTP/1.1`, host, auth, 'Depth: 0'),
      )
      expect(reply.status).toBe(404)
      const reached = (await reachedRadicale())?.filter((url) => url.includes(marker)) ?? []
      for (const url of reached) expect(url.startsWith(`/${aliceSub}/`)).toBe(true)
    })
  })

  describe('framing the Node parser refuses', () => {
    const put = (marker: string, ...headers: string[]) => [
      `PUT /caldav/${aliceSub}/def-calendar/${marker}.ics HTTP/1.1`,
      host,
      auth,
      'Content-Type: text/calendar',
      ...headers,
    ]

    it('answers 400 for Transfer-Encoding together with Content-Length (request smuggling)', async () => {
      const marker = 'raw-te-cl'
      const reply = await exchange(
        lines(...put(marker, 'Transfer-Encoding: chunked', 'Content-Length: 4')) + '0\r\n\r\n',
      )
      expect(reply.status).toBe(400)
      await expectNotForwarded(marker)
    })

    it('answers 400 for an unknown transfer coding', async () => {
      const marker = 'raw-te-x'
      const reply = await exchange(
        lines(...put(marker, 'Transfer-Encoding: xchunked')) + '0\r\n\r\n',
      )
      expect(reply.status).toBe(400)
      await expectNotForwarded(marker)
    })

    it('answers 400 for two different Content-Length headers', async () => {
      const marker = 'raw-cl-cl'
      const reply = await exchange(
        lines(...put(marker, 'Content-Length: 4', 'Content-Length: 5')) + 'abcde',
      )
      expect(reply.status).toBe(400)
      await expectNotForwarded(marker)
    })
  })

  describe('oversized headers', () => {
    it('answers 431 for an Authorization header of 20 KB', async () => {
      const reply = await exchange(
        lines(
          `PROPFIND /caldav/${aliceSub}/ HTTP/1.1`,
          host,
          `Authorization: Bearer ${'a'.repeat(20 * 1024)}`,
        ),
      )
      expect(reply.status).toBe(431)
    })

    it('answers 401 for a credential of 9 KB: the gateway reads no header over 8 KB', async () => {
      const reply = await exchange(
        lines(
          `PROPFIND /caldav/${aliceSub}/ HTTP/1.1`,
          host,
          `Authorization: Bearer ${'a'.repeat(9 * 1024)}`,
        ),
      )
      expect(reply.status).toBe(401)
    })
  })
})
