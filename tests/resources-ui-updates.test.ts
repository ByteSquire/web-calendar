import { describe, expect, it } from 'vitest'
import type { BookingUpdate } from '../shared/types/resources-api'
import {
  firstSinceIso,
  lastSeenKey,
  newestDecision,
  readLastSeen,
  updatesToastText,
  writeLastSeen,
  type KeyValueStore,
} from '../app/utils/resources/updates'

const update = (extra: Partial<BookingUpdate> = {}): BookingUpdate => ({
  bookingId: 1,
  resourceId: 5,
  resourceName: 'Room 1',
  status: 'approved',
  decidedAt: '2026-11-02T10:00:00.000Z',
  reason: 'decision',
  ...extra,
})

describe('updatesToastText', () => {
  it('says nothing without updates', () => {
    expect(updatesToastText([])).toBeNull()
  })

  it('words one update by what happened', () => {
    expect(updatesToastText([update()])).toBe('Your booking for Room 1 was approved')
    expect(updatesToastText([update({ status: 'declined' })])).toBe(
      'Your booking for Room 1 was declined',
    )
    expect(updatesToastText([update({ status: 'cancelled' })])).toBe(
      'Your booking for Room 1 was cancelled',
    )
    expect(updatesToastText([update({ status: 'cancelled', reason: 'event_moved' })])).toBe(
      'Your booking for Room 1 moved, re-approval requested',
    )
    expect(updatesToastText([update({ status: 'cancelled', reason: 'event_removed' })])).toContain(
      'the event is gone',
    )
    expect(updatesToastText([update({ status: 'declined', reason: 'overlap' })])).toContain(
      'another request was approved',
    )
  })

  it('counts several in one text', () => {
    expect(updatesToastText([update(), update({ bookingId: 2 })])).toBe('2 bookings changed')
    expect(updatesToastText([update(), update(), update()])).toBe('3 bookings changed')
  })
})

describe('the time of the last look', () => {
  const memory = (
    initial: Record<string, string> = {},
  ): KeyValueStore & { data: Record<string, string> } => {
    const data = { ...initial }
    return {
      data,
      getItem: (key) => data[key] ?? null,
      setItem: (key, value) => {
        data[key] = value
      },
    }
  }

  it('keeps one namespaced key per user', () => {
    expect(lastSeenKey('abc')).toBe('web-calendar:resource-updates-seen:abc')
    expect(lastSeenKey('abc')).not.toBe(lastSeenKey('abd'))
  })

  it('reads back what was written and ignores junk', () => {
    const store = memory()
    const key = lastSeenKey('u')
    expect(readLastSeen(store, key)).toBeNull()
    writeLastSeen(store, key, '2026-11-02T10:00:00.000Z')
    expect(readLastSeen(store, key)).toBe('2026-11-02T10:00:00.000Z')
    store.data[key] = 'not a time'
    expect(readLastSeen(store, key)).toBeNull()
  })

  it('survives storage that is missing or throws', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(readLastSeen(null, 'k')).toBeNull()
    expect(readLastSeen(broken, 'k')).toBeNull()
    expect(() => writeLastSeen(broken, 'k', '2026-11-02T10:00:00.000Z')).not.toThrow()
    expect(() => writeLastSeen(null, 'k', '2026-11-02T10:00:00.000Z')).not.toThrow()
  })

  it('asks for the last day on a first look', () => {
    expect(firstSinceIso(new Date('2026-11-02T10:00:00.000Z'))).toBe('2026-11-01T10:00:00.000Z')
  })

  it('remembers the newest decision', () => {
    expect(newestDecision([])).toBeNull()
    expect(
      newestDecision([
        update({ decidedAt: '2026-11-02T10:00:00.000Z' }),
        update({ decidedAt: '2026-11-03T08:00:00.000Z' }),
        update({ decidedAt: '2026-11-01T08:00:00.000Z' }),
      ]),
    ).toBe('2026-11-03T08:00:00.000Z')
  })
})
