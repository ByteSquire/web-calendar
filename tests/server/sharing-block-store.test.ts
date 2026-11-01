// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createResourceBlockStore } from '../../server/utils/sharing/block-store'
import { createRadicaleClient } from '../../server/utils/sharing/radicale-client'
import { startFakeRadicale, type FakeRadicale } from './sharing-fake-radicale'

const PATH = '/_resources/availability/0123456789abcdef0123456789abcdef.ics'
const ICS = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'

let radicale: FakeRadicale

beforeEach(async () => {
  radicale = await startFakeRadicale()
})

afterEach(() => radicale.close())

function store() {
  return createResourceBlockStore({ client: createRadicaleClient({ baseUrl: radicale.url }) })
}

describe('resource block store', () => {
  it('creates the collection once, then puts and deletes as _resources', async () => {
    const blocks = store()
    await blocks.put(PATH, ICS)
    await blocks.put(PATH, ICS)
    expect(radicale.calendars.get('_resources')?.has('availability')).toBe(true)
    expect(radicale.objects.get(PATH)).toBe(ICS)
    expect(radicale.requests.filter((r) => r.method === 'MKCALENDAR')).toHaveLength(1)
    expect(radicale.requests.every((r) => r.user === '_resources')).toBe(true)
    await blocks.delete(PATH)
    expect(radicale.objects.has(PATH)).toBe(false)
    // Deleting a block that is gone is fine.
    await blocks.delete(PATH)
  })

  it('refuses paths outside the availability collection', async () => {
    const blocks = store()
    for (const bad of [
      '/alice/cal/x.ics',
      '/_resources/availability/../x.ics',
      '/_resources/availability/a/b.ics',
      '/_resources/other/x.ics',
      '/_resources/availability/x.txt',
    ]) {
      await expect(blocks.put(bad, ICS)).rejects.toThrow()
      await expect(blocks.delete(bad)).rejects.toThrow()
    }
    expect(radicale.requests).toHaveLength(0)
  })

  it('throws when Radicale cannot be reached, so the booking can retry', async () => {
    radicale.down = true
    await expect(store().put(PATH, ICS)).rejects.toThrow()
    radicale.down = false
    await store().put(PATH, ICS)
    expect(radicale.objects.has(PATH)).toBe(true)
  })
})
