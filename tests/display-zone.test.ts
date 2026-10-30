// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { useDisplayZoneFollow } from '~/composables/useDisplayZoneFollow'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { convertWallClock } from '~/utils/time-zone'

// What the user's time zone (FR-32) does to the screens: the display zone that every component
// reads, and the calendar state following it when it changes without a reload.

const BROWSER = Intl.DateTimeFormat().resolvedOptions().timeZone

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'

// Demo mode shows the mock data; with an issuer and no demo flag the app is live (the loader fills
// the state).
function configure(demo: boolean) {
  useServerConfigState().value = {
    oidc: { issuer: demo ? '' : ISSUER, clientId: 'web-calendar', scope: 'openid' },
    timezone: 'Pacific/Auckland',
    demo,
  }
}

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  clearNuxtState()
})

describe('useDisplayTimeZone', () => {
  beforeEach(() => configure(true))

  it("is the browser's zone until the user chose one", () => {
    expect(useDisplayTimeZone().value).toBe(BROWSER)
  })

  it('follows the choice of the user, and the choice being cleared', () => {
    const zone = useDisplayTimeZone()
    useUserTimeZone().value = 'Australia/Sydney'
    expect(zone.value).toBe('Australia/Sydney')
    useUserTimeZone().value = 'Asia/Tokyo'
    expect(zone.value).toBe('Asia/Tokyo')
    useUserTimeZone().value = null
    expect(zone.value).toBe(BROWSER)
  })

  it('skips a choice that is not a zone', () => {
    useUserTimeZone().value = 'Mars/Olympus'
    expect(useDisplayTimeZone().value).toBe(BROWSER)
  })

  it('is shared: a component that asks later sees the same choice', () => {
    useUserTimeZone().value = 'Asia/Tokyo'
    expect(useDisplayTimeZone().value).toBe('Asia/Tokyo')
    expect(useDisplayTimeZone().value).toBe(useDisplayTimeZone().value)
  })
})

describe('useDisplayZoneFollow', () => {
  async function mountFollower() {
    wrapper = await mountSuspended(
      defineComponent({
        setup() {
          useDisplayZoneFollow()
          return () => h('div')
        },
      }),
    )
  }

  describe('in demo mode', () => {
    beforeEach(() => configure(true))

    it('moves the timed events to the new zone and leaves all-day events alone', async () => {
      await mountFollower()
      const { events } = useCalendarState()
      const timed = events.value.filter((event) => !event.allDay)
      const allDay = events.value.filter((event) => event.allDay)
      expect(timed.length).toBeGreaterThan(0)
      expect(allDay.length).toBeGreaterThan(0)

      useUserTimeZone().value = 'Australia/Sydney'
      await nextTick()

      const moved = events.value.filter((event) => !event.allDay)
      expect(moved.map((event) => event.start)).toEqual(
        timed.map((event) => convertWallClock(event.start, BROWSER, 'Australia/Sydney')),
      )
      expect(moved.map((event) => event.end)).toEqual(
        timed.map((event) => convertWallClock(event.end, BROWSER, 'Australia/Sydney')),
      )
      expect(events.value.filter((event) => event.allDay)).toEqual(allDay)
    })

    it('moves them back when the choice is cleared', async () => {
      await mountFollower()
      const { events } = useCalendarState()
      const before = events.value.map((event) => [event.start, event.end])

      useUserTimeZone().value = 'America/Los_Angeles'
      await nextTick()
      expect(events.value.map((event) => [event.start, event.end])).not.toEqual(before)

      useUserTimeZone().value = null
      await nextTick()
      expect(events.value.map((event) => [event.start, event.end])).toEqual(before)
    })

    it('does not touch the events when the display zone stays the same', async () => {
      await mountFollower()
      const { events } = useCalendarState()
      const before = events.value

      useUserTimeZone().value = BROWSER
      await nextTick()
      expect(events.value).toBe(before)
    })
  })

  describe('with live data', () => {
    beforeEach(() => configure(false))

    it('leaves the events to the loader, which loads them again in the new zone', async () => {
      await mountFollower()
      const { events } = useCalendarState()
      const event = {
        id: 'e',
        uid: 'e',
        calendarId: 'dav:/caldav/u/a/',
        title: 'Standup',
        start: '2026-10-28T09:00:00',
        end: '2026-10-28T09:30:00',
        allDay: false,
        status: 'confirmed' as const,
        categoryIds: [],
      }
      events.value = [event]

      useUserTimeZone().value = 'Australia/Sydney'
      await nextTick()
      expect(events.value).toEqual([event])
    })
  })

  describe('the date the viewer is looking at', () => {
    // 23:30 UTC on Thu 29 Oct is already Fri 30 Oct in Sydney (UTC+11).
    const now = new Date('2026-10-29T23:30:00Z')

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(now)
      configure(true)
    })

    it('stays on today when today is another date in the new zone', async () => {
      await mountFollower()
      const { anchorDate } = useCalendarState()
      anchorDate.value = Temporal.Now.plainDateISO(BROWSER)
      expect(anchorDate.value.toString()).not.toBe('2026-10-30')

      useUserTimeZone().value = 'Australia/Sydney'
      await nextTick()
      expect(anchorDate.value.toString()).toBe('2026-10-30')
    })

    it('stays where it is when the viewer looks at another date', async () => {
      await mountFollower()
      const { anchorDate } = useCalendarState()
      anchorDate.value = Temporal.PlainDate.from('2026-12-24')

      useUserTimeZone().value = 'Australia/Sydney'
      await nextTick()
      expect(anchorDate.value.toString()).toBe('2026-12-24')
    })
  })
})
