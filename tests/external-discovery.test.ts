// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DavError, type DavErrorKind } from '../app/utils/caldav/errors'
import { discoverCalendars } from '../app/utils/external/discovery'
import { createProxyFetch } from '../app/utils/external/proxy-fetch'
import {
  HOST,
  SEALED,
  account,
  calendarProps,
  currentPrincipal,
  entry,
  folderProps,
  fakeProxy,
  homeSet,
  multistatus,
  ownError,
  principalProps,
  type UpstreamHandler,
} from './external-helpers'

// Finding the calendars behind an account's address: a calendar home, a principal, one calendar or
// a server root. The server is a fake behind the account's real proxy adapter, so every request
// also goes through the origin pinning.

function setup(url: string, upstream: UpstreamHandler, authMode: 'none' | 'basic' = 'none') {
  const proxy = fakeProxy(upstream)
  const fetchFn = createProxyFetch({
    account: account(5, { url, authMode }),
    fetch: proxy.fetch,
    sealed: () => SEALED,
  })
  return {
    calls: proxy.calls,
    discover: (options: { fallbackName?: string; signal?: AbortSignal } = {}) =>
      discoverCalendars({
        url,
        fetch: fetchFn,
        fallbackName: options.fallbackName ?? 'My account',
        ...(options.signal ? { signal: options.signal } : {}),
      }),
  }
}

async function kindOf(promise: Promise<unknown>): Promise<DavErrorKind | 'resolved'> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    if (error instanceof DavError) return error.kind
    throw error
  }
}

const requests = (calls: { method: string; path: string; headers: Headers }[]) =>
  calls.map((call) => `${call.method} ${call.path} depth:${call.headers.get('depth')}`)

describe('a calendar home', () => {
  const HOME = '/dav/calendars/me/'
  const upstream: UpstreamHandler = (call) => {
    if (call.path === HOME && call.headers.get('depth') === '0') {
      return multistatus(entry(HOME, folderProps))
    }
    if (call.path === HOME && call.headers.get('depth') === '1') {
      return multistatus(
        entry(HOME, folderProps),
        entry(`${HOME}work/`, calendarProps('Work', { color: '#FF8800FF' })),
        entry(`${HOME}home/`, calendarProps(null)),
        entry(`${HOME}tasks/`, calendarProps('Tasks', { components: ['VTODO'] })),
        entry(`${HOME}mixed/`, calendarProps('Mixed', { components: ['VTODO', 'VEVENT'] })),
        entry(`${HOME}inbox/`, folderProps),
        // a calendar that names no component set can hold events
        entry(
          `${HOME}plain/`,
          '<resourcetype><collection/><C:calendar/></resourcetype><displayname>Plain</displayname>',
        ),
        // a calendar on another host is left out, never requested
        entry(`https://evil.example${HOME}stolen/`, calendarProps('Stolen')),
        entry(`${HOST}${HOME}absolute/`, calendarProps('Absolute')),
      )
    }
    throw new Error(`unexpected ${call.method} ${call.path}`)
  }

  it('lists the calendars that can hold events, as absolute URLs on the account’s origin', async () => {
    const { discover, calls } = setup(`${HOST}${HOME}`, upstream)
    const found = await discover()
    expect(found.map((c) => [c.url, c.displayName, c.color])).toEqual([
      [`${HOST}${HOME}work/`, 'Work', '#ff8800'],
      [`${HOST}${HOME}home/`, 'home', null],
      [`${HOST}${HOME}mixed/`, 'Mixed', null],
      [`${HOST}${HOME}plain/`, 'Plain', null],
      [`${HOST}${HOME}absolute/`, 'Absolute', null],
    ])
    expect(found.every((c) => c.readOnly)).toBe(true)
    expect(found[0]!.components).toEqual(['VEVENT'])
    expect(requests(calls)).toEqual([`PROPFIND ${HOME} depth:0`, `PROPFIND ${HOME} depth:1`])
  })

  it('asks for the properties it uses, in the namespaces the protocol names', async () => {
    const { discover, calls } = setup(`${HOST}${HOME}`, upstream)
    await discover()
    const [first, second] = calls
    for (const prop of [
      'd:resourcetype',
      'd:displayname',
      'ca:calendar-color',
      'c:supported-calendar-component-set',
    ]) {
      expect(first!.body).toContain(`<${prop}/>`)
      expect(second!.body).toContain(`<${prop}/>`)
    }
    expect(first!.body).toContain('<d:current-user-principal/>')
    expect(first!.body).toContain('<c:calendar-home-set/>')
    expect(second!.body).not.toContain('current-user-principal')
    expect(first!.body).toContain('xmlns:d="DAV:"')
    expect(first!.body).toContain('xmlns:c="urn:ietf:params:xml:ns:caldav"')
  })

  it('decodes a percent-encoded name when the server gives none', async () => {
    const { discover } = setup(`${HOST}${HOME}`, (call) =>
      call.headers.get('depth') === '0'
        ? multistatus(entry(HOME, folderProps))
        : multistatus(entry(`${HOME}Team%20Plan/`, calendarProps(null))),
    )
    expect((await discover()).map((c) => c.displayName)).toEqual(['Team Plan'])
  })

  it('gives no calendar for an empty home', async () => {
    const { discover } = setup(`${HOST}${HOME}`, (call) =>
      multistatus(...(call.headers.get('depth') === '0' ? [entry(HOME, folderProps)] : [])),
    )
    expect(await discover()).toEqual([])
  })

  it('works when the address has no trailing slash', async () => {
    const { discover } = setup(`${HOST}/dav/calendars/me`, (call) =>
      call.headers.get('depth') === '0'
        ? multistatus(entry('/dav/calendars/me/', folderProps))
        : multistatus(entry('/dav/calendars/me/work/', calendarProps('Work'))),
    )
    expect((await discover()).map((c) => c.url)).toEqual([`${HOST}/dav/calendars/me/work/`])
  })

  it('works for a login: the sealed credential goes with every request', async () => {
    const { discover, calls } = setup(`${HOST}${HOME}`, upstream, 'basic')
    await discover()
    expect(calls.map((c) => c.headers.get('x-upstream-authorization'))).toEqual([
      `Sealed ${SEALED}`,
      `Sealed ${SEALED}`,
    ])
  })
})

describe('a principal', () => {
  const PRINCIPAL = '/dav/principals/users/me/'
  const HOME = '/dav/calendars/me/'
  const upstream: UpstreamHandler = (call) => {
    if (call.path === PRINCIPAL) {
      return multistatus(entry(PRINCIPAL, principalProps(homeSet(HOME))))
    }
    if (call.path === HOME && call.headers.get('depth') === '1') {
      return multistatus(
        entry(HOME, folderProps),
        entry(`${HOME}a/`, calendarProps('A')),
        entry(`${HOME}b/`, calendarProps('B')),
      )
    }
    throw new Error(`unexpected ${call.method} ${call.path}`)
  }

  it('follows calendar-home-set and lists that home', async () => {
    const { discover, calls } = setup(`${HOST}${PRINCIPAL}`, upstream)
    expect((await discover()).map((c) => c.displayName)).toEqual(['A', 'B'])
    expect(requests(calls)).toEqual([`PROPFIND ${PRINCIPAL} depth:0`, `PROPFIND ${HOME} depth:1`])
  })

  it('reads a home-set given as an absolute URL of the same origin', async () => {
    const { discover } = setup(`${HOST}${PRINCIPAL}`, (call) =>
      call.path === PRINCIPAL
        ? multistatus(entry(PRINCIPAL, principalProps(homeSet(`${HOST}${HOME}`))))
        : upstream(call),
    )
    expect((await discover()).map((c) => c.displayName)).toEqual(['A', 'B'])
  })

  it('refuses a home on another host, and never asks it', async () => {
    const { discover, calls } = setup(`${HOST}${PRINCIPAL}`, (call) =>
      multistatus(entry(call.path, principalProps(homeSet('https://p01.evil.example/home/')))),
    )
    expect(await kindOf(discover())).toBe('bad-response')
    expect(calls).toHaveLength(1)
    expect(calls.every((c) => c.accountId === 5)).toBe(true)
  })

  it('refuses a home with a scheme-relative host', async () => {
    const { discover, calls } = setup(`${HOST}${PRINCIPAL}`, (call) =>
      multistatus(entry(call.path, principalProps(homeSet('//evil.example/home/')))),
    )
    expect(await kindOf(discover())).toBe('bad-response')
    expect(calls).toHaveLength(1)
  })
})

describe('one calendar', () => {
  const CAL = '/dav/calendars/me/work/'

  it('is the one calendar, named by the server', async () => {
    const { discover, calls } = setup(`${HOST}${CAL}`, () =>
      multistatus(entry(CAL, calendarProps('Work', { color: '#336699' }))),
    )
    const found = await discover({ fallbackName: 'Ignored' })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      url: `${HOST}${CAL}`,
      displayName: 'Work',
      color: '#336699',
      readOnly: true,
    })
    expect(requests(calls)).toEqual([`PROPFIND ${CAL} depth:0`])
  })

  it('takes the account’s name when the server names the calendar nothing', async () => {
    const { discover } = setup(`${HOST}${CAL}`, () => multistatus(entry(CAL, calendarProps(null))))
    expect((await discover({ fallbackName: 'Team calendar' })).map((c) => c.displayName)).toEqual([
      'Team calendar',
    ])
  })

  it('uses the address the server answers with when it spells it differently', async () => {
    const { discover } = setup(`${HOST}/dav/calendars/me/work`, () =>
      multistatus(entry(CAL, calendarProps('Work'))),
    )
    expect((await discover()).map((c) => c.url)).toEqual([`${HOST}${CAL}`])
  })

  it('is nothing when the calendar holds no events', async () => {
    const { discover } = setup(`${HOST}${CAL}`, () =>
      multistatus(entry(CAL, calendarProps('Tasks', { components: ['VTODO'] }))),
    )
    expect(await discover()).toEqual([])
  })
})

describe('a server root', () => {
  const ROOT = '/dav/'
  const PRINCIPAL = '/dav/principals/users/me/'
  const HOME = '/dav/calendars/me/'

  it('finds the home through current-user-principal when the root holds no calendar', async () => {
    const { discover, calls } = setup(`${HOST}${ROOT}`, (call) => {
      if (call.path === ROOT && call.headers.get('depth') === '0') {
        return multistatus(entry(ROOT, folderProps + currentPrincipal(PRINCIPAL)))
      }
      if (call.path === ROOT) {
        return multistatus(
          entry(ROOT, folderProps),
          entry('/dav/principals/', folderProps),
          entry('/dav/calendars/', folderProps),
        )
      }
      if (call.path === PRINCIPAL)
        return multistatus(entry(PRINCIPAL, principalProps(homeSet(HOME))))
      if (call.path === HOME) {
        return multistatus(entry(HOME, folderProps), entry(`${HOME}work/`, calendarProps('Work')))
      }
      throw new Error(`unexpected ${call.method} ${call.path}`)
    })
    expect((await discover()).map((c) => c.displayName)).toEqual(['Work'])
    expect(requests(calls)).toEqual([
      `PROPFIND ${ROOT} depth:0`,
      `PROPFIND ${ROOT} depth:1`,
      `PROPFIND ${PRINCIPAL} depth:0`,
      `PROPFIND ${HOME} depth:1`,
    ])
  })

  it('does not look further when the address itself is a home', async () => {
    const { discover, calls } = setup(`${HOST}${HOME}`, (call) => {
      if (call.headers.get('depth') === '0') {
        // a home that also names the principal, as Nextcloud does
        return multistatus(entry(HOME, folderProps + currentPrincipal(PRINCIPAL)))
      }
      return multistatus(entry(HOME, folderProps), entry(`${HOME}work/`, calendarProps('Work')))
    })
    expect((await discover()).map((c) => c.displayName)).toEqual(['Work'])
    expect(calls).toHaveLength(2)
  })

  it('stops when the principal leads back to the address already listed', async () => {
    const { discover, calls } = setup(`${HOST}${HOME}`, (call) => {
      if (call.headers.get('depth') === '0' && call.path === HOME) {
        return multistatus(entry(HOME, folderProps + currentPrincipal(PRINCIPAL)))
      }
      if (call.path === PRINCIPAL)
        return multistatus(entry(PRINCIPAL, principalProps(homeSet(HOME))))
      return multistatus(entry(HOME, folderProps))
    })
    expect(await discover()).toEqual([])
    expect(calls).toHaveLength(3)
  })

  it('gives nothing when the server names no principal', async () => {
    const { discover } = setup(`${HOST}${ROOT}`, () => multistatus(entry(ROOT, folderProps)))
    expect(await discover()).toEqual([])
  })

  it('refuses a principal on another host', async () => {
    const { discover, calls } = setup(`${HOST}${ROOT}`, (call) =>
      call.headers.get('depth') === '0'
        ? multistatus(entry(ROOT, folderProps + currentPrincipal('https://evil.example/p/me/')))
        : multistatus(entry(ROOT, folderProps)),
    )
    expect(await kindOf(discover())).toBe('bad-response')
    expect(calls.every((c) => c.accountId === 5)).toBe(true)
  })
})

describe('failures', () => {
  const HOME = '/dav/calendars/me/'

  it.each([
    ['the account’s 404', () => new Response('', { status: 404 }), 'not-found'],
    ['the account’s 403', () => new Response('', { status: 403 }), 'forbidden'],
    ['the account’s 500', () => new Response('', { status: 500 }), 'unavailable'],
    ['a refused login', () => new Response('', { status: 401 }), 'login-rejected'],
    ['a host the administrator did not allow', ownError.hostNotAllowed, 'host-not-allowed'],
    ['the rate limit', ownError.rateLimited, 'rate-limited'],
    ['an unreachable server', ownError.unreachable, 'network'],
    ['a void credential', ownError.credentialRequired, 'credential-needed'],
  ] as const)('maps %s to %s', async (_name, answer, kind) => {
    const { discover } = setup(`${HOST}${HOME}`, answer, 'basic')
    expect(await kindOf(discover())).toBe(kind)
  })

  it('does not accept an HTML page or plain 200 as a CalDAV answer', async () => {
    const html = setup(
      `${HOST}${HOME}`,
      () =>
        new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    expect(await kindOf(html.discover())).toBe('bad-response')
  })

  it('does not accept a cut-off or malformed multistatus', async () => {
    const cut = setup(
      `${HOST}${HOME}`,
      () =>
        new Response("<?xml version='1.0'?><multistatus xmlns='DAV:'><response><href>/x", {
          status: 207,
          headers: { 'content-type': 'text/xml' },
        }),
    )
    expect(await kindOf(cut.discover())).toBe('bad-response')
  })

  it('refuses an address with user info before sending anything', async () => {
    const { discover, calls } = setup('https://me:secret@dav.example.org/dav/', () => multistatus())
    expect(await kindOf(discover())).toBe('bad-response')
    expect(calls).toEqual([])
  })

  it('stops at once for an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { discover, calls } = setup(`${HOST}${HOME}`, () => multistatus())
    expect(await kindOf(discover({ signal: controller.signal }))).toBe('aborted')
    expect(calls).toEqual([])
  })

  it('only ever talks to the proxy of its own account', async () => {
    const { discover, calls } = setup(`${HOST}${HOME}`, (call) =>
      call.headers.get('depth') === '0'
        ? multistatus(entry(HOME, folderProps))
        : multistatus(
            entry(`https://evil.example${HOME}x/`, calendarProps('X')),
            entry(`//evil.example${HOME}y/`, calendarProps('Y')),
            entry(`${HOME}ok/`, calendarProps('Ok')),
          ),
    )
    expect((await discover()).map((c) => c.displayName)).toEqual(['Ok'])
    expect(calls.every((c) => c.accountId === 5 && c.url.startsWith('/api/external/5/'))).toBe(true)
  })
})
