// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGateway } from '../../server/utils/gateway/gateway'

// The gateway against a real HTTP server standing in for Radicale, with the real fetch: custom
// methods, streamed bodies and the Content-Length rule only show up on the wire.

interface Received {
  method: string
  url: string
  headers: IncomingMessage['headers']
  rawHeaders: string[]
  body: Buffer
}

let radicale: Server
let upstream: string
let received: Received[] = []
let reply: (request: Received, response: import('node:http').ServerResponse) => void

beforeAll(async () => {
  radicale = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: Received = {
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks),
      }
      received.push(entry)
      reply(entry, response)
    })
  })
  await new Promise<void>((resolve) => radicale.listen(0, '127.0.0.1', resolve))
  upstream = `http://127.0.0.1:${(radicale.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => radicale.close(resolve))
})

function gateway(options: { upstream?: string; maxBodyBytes?: number } = {}) {
  return createGateway({
    upstream: options.upstream ?? upstream,
    maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
    authenticate: async () => ({ sub: 'alice-sub' }),
  })
}

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async pull(controller) {
      const chunk = chunks.shift()
      if (chunk === undefined) controller.close()
      else controller.enqueue(encoder.encode(chunk))
    },
  })
}

async function send(
  handle: ReturnType<typeof gateway>,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  requestBody: ReadableStream<Uint8Array> | null = null,
) {
  received = []
  return handle({ method, target, headers: new Headers(headers), body: requestBody })
}

const XML = '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>'

describe('gateway over HTTP', () => {
  it('forwards PROPFIND with its XML body, its Depth and the identity headers', async () => {
    reply = (_request, response) => {
      response.writeHead(207, { 'content-type': 'text/xml; charset=utf-8', dav: '1, 2' })
      response.end('<multistatus xmlns="DAV:"/>')
    }
    const length = String(Buffer.byteLength(XML))
    const response = await send(
      gateway(),
      'PROPFIND',
      '/caldav/alice-sub/?ignored=1',
      {
        depth: '0',
        'content-type': 'application/xml',
        'content-length': length,
        'x-remote-user': 'bob',
      },
      body(XML.slice(0, 10), XML.slice(10)),
    )
    expect(response.status).toBe(207)
    expect(await response.text()).toBe('<multistatus xmlns="DAV:"/>')
    expect(response.headers.get('dav')).toBe('1, 2')
    expect(received).toHaveLength(1)
    const [seen] = received
    expect(seen!.method).toBe('PROPFIND')
    expect(seen!.url).toBe('/alice-sub/')
    expect(seen!.body.toString()).toBe(XML)
    expect(seen!.headers['content-length']).toBe(length)
    expect(seen!.headers['transfer-encoding']).toBeUndefined()
    expect(seen!.headers.depth).toBe('0')
    expect(seen!.headers['x-remote-user']).toBe('alice-sub')
    expect(seen!.headers['x-script-name']).toBe('/caldav')
    expect(seen!.headers['accept-encoding']).toBe('identity')
    // Exactly one X-Remote-User on the wire; a duplicate could be read either way.
    expect(seen!.rawHeaders.filter((name) => name.toLowerCase() === 'x-remote-user')).toHaveLength(
      1,
    )
  })

  it('forwards REPORT, MKCALENDAR, MOVE and the rest of the method list', async () => {
    reply = (_request, response) => response.writeHead(200).end()
    for (const method of ['REPORT', 'MKCALENDAR', 'MKCOL', 'PROPPATCH', 'OPTIONS', 'DELETE']) {
      const response = await send(gateway(), method, '/caldav/alice-sub/new/', {}, body('<x/>'))
      expect(response.status).toBe(200)
      expect(received[0]!.method).toBe(method)
    }
    const moved = await send(gateway(), 'MOVE', '/caldav/alice-sub/a/e.ics', {
      destination: 'https://calendar.example.org/caldav/alice-sub/b/e.ics',
    })
    expect(moved.status).toBe(200)
    expect(received[0]!.headers.destination).toBe('/caldav/alice-sub/b/e.ics')
  })

  it('sends a Content-Length for a body that arrived chunked', async () => {
    reply = (_request, response) => response.writeHead(201).end()
    const response = await send(
      gateway(),
      'PUT',
      '/caldav/alice-sub/c/e.ics',
      { 'transfer-encoding': 'chunked', 'content-type': 'text/calendar', 'if-none-match': '*' },
      body('BEGIN:VCALENDAR\r\n', 'END:VCALENDAR\r\n'),
    )
    expect(response.status).toBe(201)
    expect(received[0]!.body.toString()).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    expect(received[0]!.headers['content-length']).toBe('32')
    expect(received[0]!.headers['transfer-encoding']).toBeUndefined()
    expect(received[0]!.headers['if-none-match']).toBe('*')
  })

  it('streams a large body through intact', async () => {
    reply = (request, response) =>
      response.writeHead(201, { etag: `"${request.body.length}"` }).end()
    const chunk = 'x'.repeat(64 * 1024)
    const chunks = Array.from({ length: 8 }, () => chunk)
    const response = await send(
      gateway(),
      'PUT',
      '/caldav/alice-sub/c/big.ics',
      { 'content-length': String(chunk.length * chunks.length) },
      body(...chunks),
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('etag')).toBe(`"${512 * 1024}"`)
  })

  it('stops a body that exceeds the limit', async () => {
    reply = (_request, response) => response.writeHead(201).end()
    const handle = gateway({ maxBodyBytes: 100 })
    const declared = await send(
      handle,
      'PUT',
      '/caldav/alice-sub/c/e.ics',
      { 'content-length': '101' },
      body('x'.repeat(101)),
    )
    expect(declared.status).toBe(413)
    const chunked = await send(
      handle,
      'PUT',
      '/caldav/alice-sub/c/e.ics',
      {},
      body('x'.repeat(60), 'x'.repeat(60)),
    )
    expect(chunked.status).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('does not follow a redirect from Radicale', async () => {
    reply = (_request, response) => response.writeHead(301, { location: '/caldav/' }).end()
    const response = await send(gateway(), 'GET', '/caldav')
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/caldav/')
    expect(received).toHaveLength(1)
  })

  it('removes cookies and the server banner from Radicale’s answer', async () => {
    reply = (_request, response) => {
      response.setHeader('set-cookie', ['a=1', 'b=2'])
      response.setHeader('server', 'WSGIServer CPython/3.15.1')
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('hi')
    }
    const response = await send(gateway(), 'GET', '/caldav/alice-sub/')
    expect(response.headers.getSetCookie()).toEqual([])
    expect(response.headers.has('server')).toBe(false)
    expect(await response.text()).toBe('hi')
  })

  it('keeps the length of a HEAD answer', async () => {
    reply = (_request, response) => {
      response.writeHead(200, { 'content-length': '1234', 'content-type': 'text/calendar' })
      response.end()
    }
    const response = await send(gateway(), 'HEAD', '/caldav/alice-sub/c/e.ics')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('1234')
  })

  it('sends a body that Radicale compressed on its own without the stale encoding headers', async () => {
    const payload = gzipSync('<multistatus/>')
    reply = (_request, response) => {
      response.writeHead(207, {
        'content-encoding': 'gzip',
        'content-length': String(payload.length),
      })
      response.end(payload)
    }
    const response = await send(gateway(), 'PROPFIND', '/caldav/alice-sub/')
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(response.headers.has('content-length')).toBe(false)
    expect(await response.text()).toBe('<multistatus/>')
  })

  it('answers 502 when Radicale is down', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    const response = await send(
      gateway({ upstream: `http://127.0.0.1:${port}` }),
      'GET',
      '/caldav/',
    )
    expect(response.status).toBe(502)
  })
})
