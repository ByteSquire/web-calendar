import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A stand-in for Radicale's sharing API and the few WebDAV calls the sharing writer makes. It
// keeps calendars, map shares and groups in memory; user shares are visible to the member only
// after enable and unhide, group shares at once (S5 results).

export interface FakeShare {
  owner: string
  pathMapped: string
  pathOrToken: string
  user: string
  permissions: string
  enabled: boolean
  hidden: boolean
  accepted: boolean
}

export interface FakeRequest {
  user: string | undefined
  method: string
  url: string
  body: string
}

export interface FakeRadicale {
  url: string
  /** owner -> calendar names */
  calendars: Map<string, Set<string>>
  /** collection path -> object paths -> ics */
  objects: Map<string, string>
  shares: FakeShare[]
  /** group name -> members */
  groups: Map<string, Set<string>>
  requests: FakeRequest[]
  /** Hang up on every request. */
  down: boolean
  /** Answer 409 to every create. */
  rejectCreates: boolean
  close(): Promise<void>
}

function xml(owner: string, rows: { name: string; calendar: boolean }[]): string {
  const item = (href: string, calendar: boolean, name?: string) =>
    `<ns0:response><ns0:href>${href}</ns0:href><ns0:propstat><ns0:prop>` +
    (name ? `<ns0:displayname>${name}</ns0:displayname>` : '') +
    `<ns0:resourcetype><ns0:collection />${calendar ? '<ns1:calendar />' : ''}</ns0:resourcetype>` +
    '</ns0:prop><ns0:status>HTTP/1.1 200 OK</ns0:status></ns0:propstat></ns0:response>'
  return (
    '<?xml version="1.0" encoding="utf-8"?><ns0:multistatus xmlns:ns0="DAV:" xmlns:ns1="urn:ietf:params:xml:ns:caldav">' +
    item(`/${owner}/`, false) +
    rows.map((row) => item(`/${owner}/${row.name}/`, row.calendar, row.name)).join('') +
    '</ns0:multistatus>'
  )
}

export async function startFakeRadicale(): Promise<FakeRadicale> {
  const fake: FakeRadicale = {
    url: '',
    calendars: new Map(),
    objects: new Map(),
    shares: [],
    groups: new Map(),
    requests: [],
    down: false,
    rejectCreates: false,
    close: async () => undefined,
  }

  function visibleNames(member: string): string[] {
    const names: string[] = []
    for (const share of fake.shares) {
      if (share.user.startsWith(':')) {
        if (fake.groups.get(share.user.slice(1))?.has(member)) {
          names.push(share.pathOrToken.replace('{user}', member).split('/')[2]!)
        }
      } else if (share.user === member && share.accepted) {
        names.push(share.pathOrToken.split('/')[2]!)
      }
    }
    return names
  }

  function handle(request: IncomingMessage, body: string): { status: number; text: string } {
    const user = request.headers['x-remote-user'] as string | undefined
    const url = request.url ?? '/'
    const method = request.method ?? 'GET'
    if (!user) return { status: 401, text: '' }
    const api = /^\/\.sharing\/v1\/(map|token)\/(\w+)$/.exec(url)
    if (api) {
      const [, type, action] = api
      const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      if (type === 'token') return { status: 200, text: JSON.stringify({ Content: [] }) }
      if (action === 'list') {
        const content = fake.shares
          .filter((share) => share.owner === user)
          .map((share) => ({
            PathMapped: share.pathMapped,
            PathOrToken: share.pathOrToken,
            User: share.user,
            Permissions: share.user.startsWith(':') ? `u${share.permissions}ep` : share.permissions,
            Enabled: share.enabled,
            Hidden: share.hidden,
          }))
        return { status: 200, text: JSON.stringify({ Content: content }) }
      }
      if (action === 'create') {
        const clash = fake.shares.some(
          (share) =>
            share.pathMapped === String(payload.PathMapped) && share.user === String(payload.User),
        )
        if (fake.rejectCreates || clash) return { status: 409, text: '{}' }
        fake.shares.push({
          owner: user,
          pathMapped: String(payload.PathMapped),
          pathOrToken: String(payload.PathOrToken),
          user: String(payload.User),
          permissions: String(payload.Permissions),
          enabled: payload.Enabled !== false,
          hidden: false,
          accepted: false,
        })
        return { status: 200, text: '{}' }
      }
      if (action === 'delete') {
        const before = fake.shares.length
        fake.shares = fake.shares.filter(
          (share) => !(share.owner === user && share.pathOrToken === payload.PathOrToken),
        )
        return { status: fake.shares.length < before ? 200 : 404, text: '{}' }
      }
      if (action === 'enable' || action === 'unhide') {
        const share = fake.shares.find(
          (item) => item.user === user && item.pathOrToken === payload.PathOrToken,
        )
        if (!share) return { status: 404, text: '{}' }
        if (action === 'enable') share.enabled = true
        else share.hidden = false
        share.accepted = share.enabled && !share.hidden
        return { status: 200, text: '{}' }
      }
      return { status: 400, text: '{}' }
    }
    const path = decodeURIComponent(url)
    const parts = path.split('/').filter(Boolean)
    if (method === 'PROPFIND') {
      const [home, name] = parts
      if (name !== undefined) {
        return fake.calendars.get(home!)?.has(name)
          ? { status: 207, text: xml(home!, [{ name, calendar: true }]) }
          : { status: 404, text: '' }
      }
      if (home !== user) return { status: 403, text: '' }
      if (!fake.calendars.has(home)) fake.calendars.set(home, new Set())
      const rows = [...fake.calendars.get(home)!].map((name) => ({ name, calendar: true }))
      for (const name of visibleNames(user)) rows.push({ name, calendar: true })
      return { status: 207, text: xml(home, rows) }
    }
    if (method === 'MKCALENDAR') {
      const [home, name] = parts
      if (!fake.calendars.has(home!)) fake.calendars.set(home!, new Set())
      if (fake.calendars.get(home!)!.has(name!)) return { status: 405, text: '' }
      fake.calendars.get(home!)!.add(name!)
      return { status: 201, text: '' }
    }
    if (method === 'PUT') {
      if (!fake.calendars.get(parts[0]!)?.has(parts[1]!)) return { status: 409, text: '' }
      const existed = fake.objects.has(path)
      fake.objects.set(path, body)
      return { status: existed ? 204 : 201, text: '' }
    }
    if (method === 'DELETE') {
      return fake.objects.delete(path) ? { status: 204, text: '' } : { status: 404, text: '' }
    }
    return { status: 405, text: '' }
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      fake.requests.push({
        user: request.headers['x-remote-user'] as string | undefined,
        method: request.method ?? '',
        url: request.url ?? '',
        body,
      })
      if (fake.down) {
        request.socket.destroy()
        return
      }
      const result = handle(request, body)
      response.writeHead(result.status, { 'content-type': 'application/xml' })
      response.end(result.text)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise((resolve) => server.close(() => resolve()))
  return fake
}
