// @vitest-environment node
// LIVE proof of the group calendars against a real Radicale. Skipped unless the env var is set, so
// `npx vitest run` needs no Docker and no network. To run it (Radicale 3.9.0 with the project's
// deploy/radicale/config and rights, and an htgroup file that lists team_a with ALICE and BOB):
//   GROUPS_LIVE_RADICALE_URL=http://127.0.0.1:5232 npx vitest run tests/server/kgrp-live-proof.test.ts
// The calendars it creates are removed again at the end. Each run assumes a clean Radicale.
import { describe, expect, it } from 'vitest'
import { createRadicaleClient } from '../../server/utils/sharing/radicale-client'
import { groupShareName } from '../../server/utils/sharing/names'
import { removeMappedShares } from '../../server/utils/groups/calendars'

const ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e' // in team_a
const BOB = '6f9f0e2d-0000-4000-8000-000000000002' // in team_a
const CARA = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' // nobody
const COLL = '/_group-1/0c1d2e3f-4a5b-4c6d-8e7f-900112233445/'
const SHARE = groupShareName(1, 'team_a')

describe.skipIf(!process.env.GROUPS_LIVE_RADICALE_URL)('live Radicale', () => {
  it('group calendar end to end on a real Radicale', async () => {
    const r = createRadicaleClient({ baseUrl: process.env.GROUPS_LIVE_RADICALE_URL! })
    const home = async (who: string) => {
      const res = await r.propfind(who, `/${who}/`, 1)
      if (!res.ok) throw new Error(JSON.stringify(res.failure))
      return res.value
    }
    for (const who of [ALICE, BOB, CARA]) await home(who)

    const made = await r.makeCalendar('_group-1', COLL, 'Team plan', '#aabbcc')
    console.log('MKCALENDAR', JSON.stringify(made))
    expect(made.ok).toBe(true)
    const share = await r.createShare('_group-1', {
      pathMapped: COLL,
      pathOrToken: `/{user}/${SHARE}/`,
      user: ':team_a',
      permissions: 'rw',
    } as never)
    console.log('SHARE', JSON.stringify(share))
    expect(share.ok).toBe(true)

    const before = { alice: await home(ALICE), bob: await home(BOB), cara: await home(CARA) }
    console.log(
      'ALICE HOME HAS SHARE',
      before.alice.includes(SHARE),
      'BOB',
      before.bob.includes(SHARE),
      'CARA',
      before.cara.includes(SHARE),
    )
    expect(before.alice).toContain(SHARE)
    expect(before.bob).toContain(SHARE)
    expect(before.cara).not.toContain(SHARE)

    const renamed = await r.setDisplayName('_group-1', COLL, 'Renamed plan')
    const recoloured = await r.setColor('_group-1', COLL, '#010203')
    console.log('PROPPATCH', JSON.stringify(renamed), JSON.stringify(recoloured))
    expect(renamed.ok && recoloured.ok).toBe(true)
    const own = await r.propfind('_group-1', COLL, 0)
    if (!own.ok) throw new Error(JSON.stringify(own.failure))
    console.log(
      'OWN PROPFIND HAS NAME',
      own.value.includes('Renamed plan'),
      'COLOUR',
      own.value.includes('#010203'),
    )
    expect(own.value).toContain('Renamed plan')
    // The client's PROPFIND does not ask for the colour, so ask for it directly.
    const raw = await fetch(`${process.env.GROUPS_LIVE_RADICALE_URL}${COLL}`, {
      method: 'PROPFIND',
      headers: { 'x-remote-user': '_group-1', depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:I="http://apple.com/ns/ical/"><D:prop><I:calendar-color/></D:prop></D:propfind>',
    })
    const rawText = await raw.text()
    console.log(
      'RAW COLOUR PROPFIND',
      raw.status,
      rawText.match(/calendar-color[^<]*<?[^<]*/)?.[0] ?? rawText.slice(0, 400),
    )
    expect(rawText).toContain('#010203')

    // The same sequence as the service: the mapped share goes first (Radicale refuses otherwise).
    expect(await removeMappedShares(r, '_group-1', COLL)).toBe(true)
    // Clearing the colour: PROPPATCH remove, then the colour is gone from the collection.
    const cleared = await r.clearColor('_group-1', COLL)
    console.log('CLEAR COLOUR', JSON.stringify(cleared))
    expect(cleared.ok).toBe(true)
    const rawAfterClear = await fetch(`${process.env.GROUPS_LIVE_RADICALE_URL}${COLL}`, {
      method: 'PROPFIND',
      headers: { 'x-remote-user': '_group-1', depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:I="http://apple.com/ns/ical/"><D:prop><I:calendar-color/></D:prop></D:propfind>',
    })
    const clearedText = await rawAfterClear.text()
    console.log('COLOUR AFTER CLEAR PRESENT', clearedText.includes('#010203'))
    expect(clearedText).not.toContain('#010203')
    const deleted = await r.deleteCollection('_group-1', COLL)
    console.log('DELETE', JSON.stringify(deleted))
    expect(deleted.ok).toBe(true)
    const after = { alice: await home(ALICE), bob: await home(BOB) }
    console.log(
      'AFTER DELETE ALICE HAS SHARE',
      after.alice.includes(SHARE),
      'BOB',
      after.bob.includes(SHARE),
    )
    expect(after.alice).not.toContain(SHARE)
    expect(after.bob).not.toContain(SHARE)
    expect((await r.deleteCollection('_group-1', COLL)).ok).toBe(true)
  })
})
