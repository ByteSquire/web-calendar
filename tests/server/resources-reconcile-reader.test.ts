// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createBookingEventReader } from '../../server/utils/resources/reconcile-reader'

function readerFor(answers: { status: number; body: string }[]) {
  const calls: { url: string; method: string; user: string | null }[] = []
  const reader = createBookingEventReader({
    baseUrl: 'http://radicale:5232',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        user: new Headers(init.headers).get('x-remote-user'),
      })
      const answer = answers.shift() ?? { status: 500, body: '' }
      return new Response(answer.body, { status: answer.status })
    }) as unknown as typeof fetch,
  })
  return { reader, calls }
}

describe('booking event reader', () => {
  it('reads the ctag and sync-token as the booker', async () => {
    const { reader, calls } = readerFor([
      {
        status: 207,
        body: '<multistatus xmlns="DAV:"><response><propstat><prop><CS:getctag xmlns:CS="http://calendarserver.org/ns/">c9</CS:getctag><sync-token>t1</sync-token></prop></propstat></response></multistatus>',
      },
    ])
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'ok', stamp: 'c9|t1' })
    expect(calls[0]).toMatchObject({ method: 'PROPFIND', user: 'sub-1' })
  })

  it('tells a missing calendar, a forbidden one and an error apart', async () => {
    const { reader } = readerFor([
      { status: 404, body: '' },
      { status: 403, body: '' },
      { status: 503, body: '' },
      { status: 200, body: '' },
    ])
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'no_collection' })
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'forbidden' })
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'error' })
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'error' })
  })

  it('maps a 403, a 404 and a failing request of the REPORT the same way', async () => {
    const { reader } = readerFor([
      { status: 403, body: '' },
      { status: 404, body: '' },
      { status: 500, body: '' },
    ])
    expect(await reader.findEvent('sub-1', '/sub-1/shared-4/', 'ev-1')).toEqual({
      kind: 'forbidden',
    })
    expect(await reader.findEvent('sub-1', '/sub-1/shared-4/', 'ev-1')).toEqual({
      kind: 'no_collection',
    })
    expect(await reader.findEvent('sub-1', '/sub-1/shared-4/', 'ev-1')).toEqual({ kind: 'error' })
  })

  it('answers error when the request throws or times out', async () => {
    const reader = createBookingEventReader({
      baseUrl: 'http://radicale:5232',
      fetch: (async () => {
        throw new DOMException('timed out', 'TimeoutError')
      }) as unknown as typeof fetch,
    })
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'error' })
    expect(await reader.findEvent('sub-1', '/sub-1/work/', 'ev-1')).toEqual({ kind: 'error' })
    expect(await reader.listCalendars('sub-1')).toEqual({ kind: 'error' })
  })

  it('encodes each segment of the path in the request URL', async () => {
    const { reader, calls } = readerFor([
      { status: 404, body: '' },
      { status: 404, body: '' },
    ])
    await reader.stamp('sub-1', '/sub-1/Büro 100%/')
    await reader.findEvent('sub-1', '/sub-1/shared-4-staff/', 'ev-1')
    expect(calls[0]?.url).toBe('http://radicale:5232/sub-1/B%C3%BCro%20100%25/')
    expect(calls[1]?.url).toBe('http://radicale:5232/sub-1/shared-4-staff/')
  })

  it('lists the calendars of the home with decoded hrefs, shares included', async () => {
    const calendar = (href: string) =>
      `<response><href>${href}</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype></prop></propstat></response>`
    const { reader, calls } = readerFor([
      {
        status: 207,
        body:
          '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          '<response><href>/sub-1/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>' +
          calendar('/sub-1/work/') +
          calendar('/sub-1/B%C3%BCro%20a/') +
          calendar('/sub-1/shared-12/') +
          calendar('/sub-1/shared-12-staff/') +
          calendar('/sub-2/other/') +
          '</multistatus>',
      },
    ])
    expect(await reader.listCalendars('sub-1')).toEqual({
      kind: 'ok',
      paths: ['/sub-1/Büro a/', '/sub-1/shared-12-staff/', '/sub-1/shared-12/', '/sub-1/work/'],
    })
    expect(calls[0]).toMatchObject({ method: 'PROPFIND', user: 'sub-1' })
  })

  it('returns the objects of a REPORT, or absent when there are none', async () => {
    const { reader } = readerFor([
      {
        status: 207,
        body: '<multistatus xmlns="DAV:"><response><propstat><prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR&amp;x</C:calendar-data></prop></propstat></response></multistatus>',
      },
      { status: 207, body: '<multistatus xmlns="DAV:"></multistatus>' },
    ])
    expect(await reader.findEvent('sub-1', '/sub-1/work/', 'ev-1')).toEqual({
      kind: 'found',
      objects: ['BEGIN:VCALENDAR&x'],
    })
    expect(await reader.findEvent('sub-1', '/sub-1/work/', 'ev-1')).toEqual({ kind: 'absent' })
  })

  it('refuses an invalid principal or path without a request', async () => {
    const { reader, calls } = readerFor([])
    expect(await reader.stamp('../x', '/a/')).toEqual({ kind: 'error' })
    expect(await reader.stamp('sub-1', '/a/../b/')).toEqual({ kind: 'error' })
    expect(calls).toEqual([])
  })
})
