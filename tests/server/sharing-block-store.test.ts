// @vitest-environment node
// The writer of the resource blocks and the calendars of the resources (design §5): one calendar per
// resource in the `_resources` home, named after it, written as `_resources` only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createResourceBlockStore,
  syncResourceCollections,
} from '../../server/utils/sharing/block-store'
import { createRadicaleClient } from '../../server/utils/sharing/radicale-client'
import { startFakeRadicale, type FakeRadicale } from './sharing-fake-radicale'

const REF = '0123456789abcdef0123456789abcdef'
const PATH = `/_resources/resource-5/${REF}.ics`
const ICS = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'

let radicale: FakeRadicale

beforeEach(async () => {
  radicale = await startFakeRadicale()
})

afterEach(() => radicale.close())

const client = () => createRadicaleClient({ baseUrl: radicale.url })

function store(names: Record<number, string> = { 5: 'Room A' }) {
  return createResourceBlockStore({ client: client(), nameOf: (id) => names[id] ?? null })
}

describe('resource block store', () => {
  it("makes the resource's calendar once, named after it, then puts and deletes as _resources", async () => {
    const blocks = store()
    await blocks.put(PATH, ICS)
    await blocks.put(PATH, ICS)
    expect(radicale.calendars.get('_resources')?.has('resource-5')).toBe(true)
    expect(radicale.displayNames.get('/_resources/resource-5/')).toBe('Room A')
    expect(radicale.objects.get(PATH)).toBe(ICS)
    expect(radicale.requests.filter((r) => r.method === 'MKCALENDAR')).toHaveLength(1)
    // The same text is not written again; a new text is.
    expect(radicale.requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
    await blocks.put(PATH, `${ICS}\r\n`)
    expect(radicale.requests.filter((r) => r.method === 'PUT')).toHaveLength(2)
    expect(radicale.requests.every((r) => r.user === '_resources')).toBe(true)
    await blocks.delete(PATH)
    expect(radicale.objects.has(PATH)).toBe(false)
    // Deleting a block that is gone is fine; putting it again writes it again.
    await blocks.delete(PATH)
    await blocks.put(PATH, ICS)
    expect(radicale.objects.get(PATH)).toBe(ICS)
  })

  it("refuses paths outside a resource's calendar", async () => {
    const blocks = store()
    for (const bad of [
      '/alice/cal/x.ics',
      `/_resources/availability/${REF}.ics`,
      `/_resources/resource-0/${REF}.ics`,
      `/_resources/resource-05/${REF}.ics`,
      `/_resources/resource-5-team/${REF}.ics`,
      '/_resources/resource-5/../x.ics',
      `/_resources/resource-5/a/${REF}.ics`,
      '/_resources/resource-5/x.txt',
    ]) {
      await expect(blocks.put(bad, ICS)).rejects.toThrow()
      await expect(blocks.delete(bad)).rejects.toThrow()
    }
    expect(radicale.requests).toHaveLength(0)
  })

  it('writes nothing for a resource that is gone', async () => {
    await expect(store({}).put(PATH, ICS)).rejects.toThrow()
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

describe('the calendars of the resources', () => {
  it('makes, renames and removes them, and the one collection of all blocks used before', async () => {
    const made = await syncResourceCollections(client(), [
      { id: 1, name: 'Room A' },
      { id: 2, name: 'Van' },
    ])
    expect(made).toEqual({ ok: true, value: { failed: [], problems: [] } })
    expect([...radicale.calendars.get('_resources')!].sort()).toEqual(['resource-1', 'resource-2'])
    expect(radicale.displayNames.get('/_resources/resource-2/')).toBe('Van')

    // The old collection, a deleted resource's calendar and something else of the home.
    for (const name of ['availability', 'resource-9', 'notes']) {
      radicale.calendars.get('_resources')!.add(name)
    }
    radicale.objects.set(`/_resources/availability/${REF}.ics`, ICS)
    const before = radicale.requests.length
    const synced = await syncResourceCollections(client(), [
      { id: 1, name: 'Room A' },
      { id: 2, name: 'Van & trailer' },
    ])
    expect(synced).toEqual({ ok: true, value: { failed: [], problems: [] } })
    expect([...radicale.calendars.get('_resources')!].sort()).toEqual([
      'notes',
      'resource-1',
      'resource-2',
    ])
    expect(radicale.displayNames.get('/_resources/resource-2/')).toBe('Van & trailer')
    expect(radicale.objects.size).toBe(0)
    // Room A kept its name: one rename, no creates.
    const after = radicale.requests.slice(before)
    expect(after.filter((r) => r.method === 'PROPPATCH')).toHaveLength(1)
    expect(after.filter((r) => r.method === 'MKCALENDAR')).toHaveLength(0)
    expect(after.every((r) => r.user === '_resources')).toBe(true)
  })

  it('fails as a whole only when Radicale cannot be reached', async () => {
    radicale.down = true
    const result = await syncResourceCollections(client(), [{ id: 1, name: 'Room A' }])
    expect(result.ok).toBe(false)
  })
})
