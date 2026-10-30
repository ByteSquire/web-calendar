// @vitest-environment node
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authenticateRequest } from '../../server/utils/auth/authenticate'
import { AuthError } from '../../server/utils/auth/errors'
import {
  challengeLines,
  emitChallengeLines,
  rememberChallengeLines,
} from '../../server/utils/gateway/challenges'
import { createGateway } from '../../server/utils/gateway/gateway'

// The two challenges of a 401 must be two lines on the wire. A web `Headers` joins them, and h3 writes
// what it finds, so the glue puts them on the Node response itself: this is that glue, in a real h3
// app behind a real socket, with the real authentication and the real gateway.

const BASIC = 'Basic realm="Web Calendar"'
const BEARER = 'Bearer realm="Web Calendar"'

let server: Server
let port: number

beforeAll(async () => {
  const gateway = createGateway({
    upstream: 'http://radicale:5232',
    maxBodyBytes: 1000,
    authenticate: (headers) =>
      authenticateRequest(headers, {
        verifier: {
          verify: async () => {
            throw new AuthError('expired')
          },
        },
        verifyAppToken: () => null,
      }),
  })
  const app = createApp()
  app.use(
    '/caldav',
    defineEventHandler(async (event) => {
      const response = await gateway({
        method: event.method,
        target: '/caldav/',
        headers: event.headers,
        body: null,
      })
      emitChallengeLines(event.node.res, response)
      return response
    }),
  )
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function rawHeaders(headers: Record<string, string> = {}) {
  return new Promise<{ status: number; raw: string[] }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/caldav/', method: 'PROPFIND', headers },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode!, raw: res.rawHeaders }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** The values of every header line called `name`, as they appeared on the wire. */
const lines = (raw: string[], name: string) =>
  raw.flatMap((value, index) =>
    index % 2 === 0 && value.toLowerCase() === name ? [raw[index + 1]!] : [],
  )

describe('WWW-Authenticate on the wire', () => {
  it('sends the Basic and the Bearer challenge as two lines, Basic first', async () => {
    const { status, raw } = await rawHeaders()
    expect(status).toBe(401)
    expect(lines(raw, 'www-authenticate')).toEqual([BASIC, BEARER])
  })

  it('sends the challenge of a rejected bearer token with its error on its own line', async () => {
    const { raw } = await rawHeaders({ authorization: 'Bearer a.b.c' })
    expect(lines(raw, 'www-authenticate')).toEqual([BASIC, `${BEARER}, error="invalid_token"`])
  })

  it('does not use a charset parameter that some clients trip over', async () => {
    const { raw } = await rawHeaders()
    expect(lines(raw, 'www-authenticate').join('\n')).not.toMatch(/charset/i)
  })
})

describe('challenge lines', () => {
  it('are remembered next to the response and written as separate lines', () => {
    const response = new Response(null, { status: 401 })
    response.headers.append('www-authenticate', BASIC)
    response.headers.append('www-authenticate', BEARER)
    rememberChallengeLines(response, [BASIC, BEARER])
    expect(response.headers.get('www-authenticate')).toBe(`${BASIC}, ${BEARER}`)

    const written: [string, string[]][] = []
    emitChallengeLines({ setHeader: (name, value) => written.push([name, value]) }, response)
    expect(written).toEqual([['www-authenticate', [BASIC, BEARER]]])
    // The joined header is gone, or h3 would write it over the lines.
    expect(response.headers.has('www-authenticate')).toBe(false)
  })

  it('leave a response without challenges alone', () => {
    const response = new Response('ok', { headers: { 'www-authenticate': 'Custom x' } })
    rememberChallengeLines(response, [])
    expect(challengeLines(response)).toEqual([])
    const written: unknown[] = []
    emitChallengeLines({ setHeader: (...args) => written.push(args) }, response)
    expect(written).toEqual([])
    expect(response.headers.get('www-authenticate')).toBe('Custom x')
  })

  it('belong to one response and not to the next', () => {
    const first = new Response(null, { status: 401 })
    rememberChallengeLines(first, [BASIC])
    expect(challengeLines(new Response(null, { status: 401 }))).toEqual([])
    expect(challengeLines(first)).toEqual([BASIC])
  })
})
