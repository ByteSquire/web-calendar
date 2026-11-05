// @vitest-environment node
// The Radicale calls that group calendars need: MKCALENDAR with a colour, PROPPATCH of the name and
// colour (a refused property is a failure), DELETE of a whole collection, and the names escaped.
import { describe, expect, it } from 'vitest'
import { createRadicaleClient, xmlSafeText } from '../../server/utils/sharing/radicale-client'

interface Sent {
  method: string
  url: string
  user: string | null
  body: string
}

function client(answer: (sent: Sent) => Response) {
  const sent: Sent[] = []
  const radicale = createRadicaleClient({
    baseUrl: 'http://radicale.test:5232',
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      const item: Sent = {
        method: String(init?.method),
        url: String(input),
        user: headers.get('x-remote-user'),
        body: String(init?.body ?? ''),
      }
      sent.push(item)
      return answer(item)
    },
  })
  return { radicale, sent }
}

describe('group calendar calls to Radicale', () => {
  it('MKCALENDAR as the group principal, with the display name and the colour', async () => {
    const { radicale, sent } = client(() => new Response('', { status: 201 }))
    const result = await radicale.makeCalendar(
      '_group-1',
      '/_group-1/abc/',
      'Team <plan>',
      '#aabbcc',
    )
    expect(result.ok).toBe(true)
    expect(sent[0]!.method).toBe('MKCALENDAR')
    expect(sent[0]!.url).toBe('http://radicale.test:5232/_group-1/abc/')
    expect(sent[0]!.user).toBe('_group-1')
    expect(sent[0]!.body).toContain('<D:displayname>Team plan</D:displayname>')
    expect(sent[0]!.body).toContain('<ICAL:calendar-color>#aabbcc</ICAL:calendar-color>')
  })

  it('PROPPATCH sets the name and the colour, and a refused property is a failure', async () => {
    const { radicale, sent } = client(() => new Response('', { status: 207 }))
    expect((await radicale.setDisplayName('_group-1', '/_group-1/abc/', 'New')).ok).toBe(true)
    expect((await radicale.setColor('_group-1', '/_group-1/abc/', '#010203')).ok).toBe(true)
    expect(sent.map((s) => s.method)).toEqual(['PROPPATCH', 'PROPPATCH'])
    expect(sent[0]!.body).toContain('<D:displayname>New</D:displayname>')
    expect(sent[1]!.body).toContain('<ICAL:calendar-color>#010203</ICAL:calendar-color>')

    const refused = client(
      () =>
        new Response(
          '<d:multistatus><d:response><d:propstat><d:status>HTTP/1.1 403 Forbidden</d:status>' +
            '</d:propstat></d:response></d:multistatus>',
          { status: 207 },
        ),
    )
    const result = await refused.radicale.setColor('_group-1', '/_group-1/abc/', '#010203')
    expect(result.ok).toBe(false)
  })

  it('clearColor sends a PROPPATCH remove of the colour, not a set', async () => {
    const { radicale, sent } = client(() => new Response('', { status: 207 }))
    expect((await radicale.clearColor('_group-1', '/_group-1/abc/')).ok).toBe(true)
    expect(sent[0]!.method).toBe('PROPPATCH')
    expect(sent[0]!.body).toContain('<D:remove><D:prop><ICAL:calendar-color/></D:prop></D:remove>')
    expect(sent[0]!.body).not.toContain('<D:set>')
  })

  it('DELETE of the collection succeeds on 204 and on 404 (already gone)', async () => {
    const gone = client(() => new Response('', { status: 404 }))
    expect((await gone.radicale.deleteCollection('_group-1', '/_group-1/abc/')).ok).toBe(true)
    expect(gone.sent[0]!.method).toBe('DELETE')
    const denied = client(() => new Response('', { status: 403 }))
    expect((await denied.radicale.deleteCollection('_group-1', '/_group-1/abc/')).ok).toBe(false)
  })

  it('drops the characters that would end an XML element from a name', () => {
    expect(xmlSafeText(`a<b>&"'c`)).toBe('abc')
  })
})
