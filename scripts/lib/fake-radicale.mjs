// A small in-memory stand-in for Radicale, for the gateway tests against the production build
// (scripts/test-gateway-prod.mjs). It behaves like the real one for what tests/integration/
// gateway.integration.test.ts checks, and its answers are copied from Radicale 3.9.0 (the test
// stack in dev/spike-s1): the principal and the calendar listing of PROPFIND, 201 with an ETag for
// a PUT, 200 with a multistatus body for a DELETE, 403 for another user's path, hrefs under
// X-Script-Name.
//
//  - It trusts `X-Remote-User` like Radicale with `http_x_remote_user`, and every user owns exactly
//    their own home (`/<user>/`), created with the calendar `def-calendar` on first use.
//  - Implemented: OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MOVE, REPORT (every object of the
//    calendar, whatever the filter), MKCALENDAR, MKCOL, PROPPATCH (accepted, ignored). COPY and
//    anything else answer 501.
//  - It records every request it receives. The record is on a second port, the control URL, which
//    the gateway cannot reach (a path below `/caldav/` would reach the first one).
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const DAV = '1, 2, 3, calendar-access, addressbook, extended-mkcol'
const ALLOW =
  'DELETE, GET, HEAD, MKCALENDAR, MKCOL, MOVE, OPTIONS, POST, PROPFIND, PROPPATCH, PUT, REPORT'
const FORBIDDEN = 'Access to the requested resource forbidden.'
const NOT_FOUND = 'The requested resource could not be found.'

/** @param {string} value */
const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** @param {string} body */
const etagOf = (body) => `"${createHash('sha256').update(body).digest('hex')}"`

/**
 * @typedef {{ body: string, etag: string, modified: Date }} Item
 * @typedef {{ method: string, url: string, user: string }} Seen
 */

/** Closes a server and the connections it keeps open. @param {import('node:http').Server} server */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve(undefined))
    server.closeAllConnections()
  })
}

/** @param {import('node:http').Server} server */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  return /** @type {import('node:net').AddressInfo} */ (server.address()).port
}

/**
 * The path segments of a request target, or null for one that is not a plain path.
 * @param {string} target
 */
function segmentsOf(target) {
  try {
    const path = target.split('?')[0] ?? ''
    if (!path.startsWith('/')) return null
    return path
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
}

export async function startFakeRadicale() {
  // user -> calendar -> object name -> object
  /** @type {Map<string, Map<string, Map<string, Item>>>} */
  const homes = new Map()
  /** @type {Seen[]} */
  let seen = []

  /** @param {string} user */
  function homeOf(user) {
    let home = homes.get(user)
    if (!home) {
      home = new Map([['def-calendar', new Map()]])
      homes.set(user, home)
    }
    return home
  }

  /**
   * The props of a principal or calendar response, as Radicale writes them.
   * @param {string} script
   * @param {string} user
   */
  function principalProps(script, user) {
    const principal = `${script}/${user}/`
    return (
      `<principal-collection-set><href>${xml(`${script}/`)}</href></principal-collection-set>` +
      '<RADICALE:version>3.9.0</RADICALE:version>' +
      `<current-user-principal><href>${xml(principal)}</href></current-user-principal>`
    )
  }

  /** @param {string} script @param {string} user */
  function homeResponse(script, user) {
    const principal = xml(`${script}/${user}/`)
    return (
      `<response><href>${principal}</href><propstat><prop>${principalProps(script, user)}` +
      '<resourcetype><principal /><collection /></resourcetype>' +
      `<owner><href>${principal}</href></owner>` +
      `<principal-URL><href>${principal}</href></principal-URL>` +
      `<C:calendar-home-set><href>${principal}</href></C:calendar-home-set>` +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response>'
    )
  }

  /**
   * @param {string} script
   * @param {string} user
   * @param {string} name
   * @param {Map<string, Item>} items
   */
  function calendarResponse(script, user, name, items) {
    const etag = xml(etagOf([...items.keys()].sort().join('\n')))
    return (
      `<response><href>${xml(`${script}/${user}/${name}/`)}</href><propstat><prop>${principalProps(script, user)}` +
      '<resourcetype><C:calendar /><collection /></resourcetype>' +
      `<owner><href>${xml(`${script}/${user}/`)}</href></owner>` +
      `<getetag>${etag}</getetag><getcontenttype>text/calendar</getcontenttype>` +
      '<displayname>Personal Calendar</displayname>' +
      '<C:supported-calendar-component-set><C:comp name="VEVENT" /><C:comp name="VJOURNAL" /><C:comp name="VTODO" /></C:supported-calendar-component-set>' +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response>'
    )
  }

  /** @param {string} script @param {string} path @param {Item} item @param {boolean} withData */
  function itemResponse(script, path, item, withData) {
    return (
      `<response><href>${xml(`${script}${path}`)}</href><propstat><prop>` +
      `<getetag>${xml(item.etag)}</getetag>` +
      (withData ? `<C:calendar-data>${xml(item.body)}</C:calendar-data>` : '') +
      '<getcontenttype>text/calendar; charset=utf-8; component=vevent</getcontenttype>' +
      `<getcontentlength>${Buffer.byteLength(item.body)}</getcontentlength>` +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response>'
    )
  }

  /** @param {string[]} responses @param {boolean} withCalendarNamespace */
  function multistatus(responses, withCalendarNamespace = true) {
    const namespaces =
      'xmlns="DAV:"' +
      (withCalendarNamespace
        ? ' xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:RADICALE="http://radicale.org/ns/"'
        : '')
    return `<?xml version='1.0' encoding='utf-8'?>\n<multistatus ${namespaces}>${responses.join('')}</multistatus>`
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {string} body
   * @param {Record<string, string>} [headers]
   */
  function send(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers })
    response.end(body)
  }
  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {string} body
   */
  const plain = (response, status, body) =>
    send(response, status, body, { 'content-type': 'text/plain; charset=utf-8' })
  /** @param {import('node:http').ServerResponse} response @param {string} body */
  const multi = (response, body) =>
    send(response, 207, body, { 'content-type': 'text/xml; charset=utf-8', dav: DAV })

  // Radicale answers a DELETE with 200 and a multistatus body, not with 207.
  /** @param {import('node:http').ServerResponse} response @param {string} href */
  const deleted = (response, href) =>
    send(
      response,
      200,
      multistatus(
        [`<response><href>${xml(href)}</href><status>HTTP/1.1 200 OK</status></response>`],
        false,
      ),
      { 'content-type': 'text/xml; charset=utf-8' },
    )

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} body
   */
  function handle(request, response, body) {
    const method = request.method ?? 'GET'
    const target = request.url ?? '/'
    const user = String(request.headers['x-remote-user'] ?? '')
    const script = String(request.headers['x-script-name'] ?? '')
    seen.push({ method, url: target, user })
    if (user === '') return plain(response, 401, 'Authentication required.')
    const segments = segmentsOf(target)
    if (segments === null) return plain(response, 400, 'Bad request.')
    const depth = request.headers.depth === '0' ? 0 : 1
    const [owner, calendarName, objectName] = segments

    if (method === 'OPTIONS') {
      response.writeHead(200, { allow: ALLOW, dav: DAV, 'content-length': 0 })
      return void response.end()
    }

    // The root lists the caller's home; everything else there is closed.
    if (owner === undefined) {
      if (method !== 'PROPFIND') return plain(response, 403, FORBIDDEN)
      const responses = [
        `<response><href>${xml(`${script}/`)}</href><propstat><prop>${principalProps(script, user)}` +
          '<resourcetype><collection /></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>',
      ]
      if (depth === 1) responses.push(homeResponse(script, user))
      return multi(response, multistatus(responses))
    }
    // Rights: the owner of a home may do anything below it, nobody else anything.
    if (owner !== user) return plain(response, 403, FORBIDDEN)
    const home = homeOf(user)

    if (calendarName === undefined) {
      if (method !== 'PROPFIND') return plain(response, 405, 'Method not allowed.')
      const responses = [homeResponse(script, user)]
      if (depth === 1) {
        for (const [name, items] of home)
          responses.push(calendarResponse(script, user, name, items))
      }
      return multi(response, multistatus(responses))
    }

    const calendar = home.get(calendarName)
    if (objectName === undefined) {
      switch (method) {
        case 'MKCALENDAR':
        case 'MKCOL':
          if (calendar) return plain(response, 405, 'Method not allowed.')
          home.set(calendarName, new Map())
          return send(response, 201, '')
        case 'PROPFIND': {
          if (!calendar) return plain(response, 404, NOT_FOUND)
          const responses = [calendarResponse(script, user, calendarName, calendar)]
          if (depth === 1) {
            for (const [name, item] of calendar) {
              responses.push(itemResponse(script, `/${user}/${calendarName}/${name}`, item, false))
            }
          }
          return multi(response, multistatus(responses))
        }
        case 'REPORT': {
          if (!calendar) return plain(response, 404, NOT_FOUND)
          const responses = [...calendar].map(([name, item]) =>
            itemResponse(script, `/${user}/${calendarName}/${name}`, item, true),
          )
          return multi(response, multistatus(responses))
        }
        case 'PROPPATCH':
          if (!calendar) return plain(response, 404, NOT_FOUND)
          return multi(response, multistatus([]))
        case 'GET':
        case 'HEAD':
          if (!calendar) return plain(response, 404, NOT_FOUND)
          return send(
            response,
            200,
            method === 'HEAD'
              ? ''
              : `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${[...calendar.values()].map((item) => item.body).join('')}END:VCALENDAR\r\n`,
            { 'content-type': 'text/calendar; charset=utf-8' },
          )
        case 'DELETE':
          if (!calendar) return plain(response, 404, NOT_FOUND)
          home.delete(calendarName)
          return deleted(response, `${script}/${user}/${calendarName}/`)
        default:
          return plain(response, 501, 'Not implemented.')
      }
    }

    // An object: /<user>/<calendar>/<object>
    if (!calendar) return plain(response, method === 'PUT' ? 409 : 404, NOT_FOUND)
    const item = calendar.get(objectName)
    const path = `/${user}/${calendarName}/${objectName}`
    switch (method) {
      case 'GET':
      case 'HEAD':
        if (!item) return plain(response, 404, NOT_FOUND)
        return send(response, 200, method === 'HEAD' ? '' : item.body, {
          'content-type': 'text/calendar; charset=utf-8',
          etag: item.etag,
          'last-modified': item.modified.toUTCString(),
        })
      case 'PUT': {
        if (!body.startsWith('BEGIN:VCALENDAR')) return plain(response, 400, 'Invalid calendar.')
        if (item && request.headers['if-none-match'] === '*')
          return plain(response, 412, 'Precondition failed.')
        if (item && request.headers['if-match'] && request.headers['if-match'] !== item.etag) {
          return plain(response, 412, 'Precondition failed.')
        }
        const etag = etagOf(body)
        calendar.set(objectName, { body, etag, modified: new Date() })
        return send(response, item ? 204 : 201, '', { etag })
      }
      case 'DELETE':
        if (!item) return plain(response, 404, NOT_FOUND)
        calendar.delete(objectName)
        return deleted(response, `${script}${path}`)
      case 'PROPFIND':
        if (!item) return plain(response, 404, NOT_FOUND)
        return multi(response, multistatus([itemResponse(script, path, item, false)]))
      case 'MOVE': {
        if (!item) return plain(response, 404, NOT_FOUND)
        // The gateway sends a path under /caldav/; Radicale reads it relative to X-Script-Name.
        const destination = String(request.headers.destination ?? '')
        const stripped = destination.startsWith(`${script}/`)
          ? destination.slice(script.length)
          : destination
        const [toOwner, toCalendar, toObject] = segmentsOf(stripped) ?? []
        if (!toOwner || !toCalendar || !toObject) return plain(response, 400, 'Bad destination.')
        if (toOwner !== user) return plain(response, 403, FORBIDDEN)
        const moveTo = home.get(toCalendar)
        if (!moveTo) return plain(response, 409, 'Conflict.')
        const exists = moveTo.has(toObject)
        if (exists && String(request.headers.overwrite ?? 'T').toUpperCase() === 'F') {
          return plain(response, 412, 'Precondition failed.')
        }
        calendar.delete(objectName)
        moveTo.set(toObject, item)
        return send(response, exists ? 204 : 201, '')
      }
      default:
        return plain(response, 501, 'Not implemented.')
    }
  }

  const server = createServer((request, response) => {
    const chunks = /** @type {Buffer[]} */ ([])
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        handle(request, response, Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        plain(response, 500, error instanceof Error ? error.message : String(error))
      }
    })
  })

  // The record of what reached the fake, on a port the gateway does not know.
  const control = createServer((request, response) => {
    if (request.method === 'DELETE') seen = []
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen))
  })

  const port = await listen(server)
  const controlPort = await listen(control)
  return {
    url: `http://127.0.0.1:${port}`,
    /** `GET` lists the requests received so far as JSON, `DELETE` lists and forgets them. */
    controlUrl: `http://127.0.0.1:${controlPort}`,
    seen: () => [...seen],
    close: () => Promise.all([closeServer(server), closeServer(control)]),
  }
}
