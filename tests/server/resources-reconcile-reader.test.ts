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

  it('tells a missing calendar from an error', async () => {
    const { reader } = readerFor([
      { status: 404, body: '' },
      { status: 503, body: '' },
    ])
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'gone' })
    expect(await reader.stamp('sub-1', '/sub-1/work/')).toEqual({ kind: 'error' })
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
