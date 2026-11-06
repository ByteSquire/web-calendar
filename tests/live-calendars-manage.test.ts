// Which calendars the viewer may rename and delete (`manage`): their own collections, and shares
// of calendars of a group they manage. Everything else gets no `manage`.
import { describe, expect, it } from 'vitest'
import type { DavCalendar } from '../app/utils/caldav/types'
import type { ApiSharedCalendar } from '../app/utils/live/api-types'
import { buildCalendars, serverCalendarOf } from '../app/utils/live/calendars'

function collection(path: string, displayName: string): DavCalendar {
  return {
    url: path,
    displayName,
    color: null,
    ctag: null,
    components: ['VEVENT'],
    readOnly: false,
    freeBusyOnly: false,
  }
}

const shared = (extra: Partial<ApiSharedCalendar>): ApiSharedCalendar => ({
  id: 7,
  name: 'Staff',
  kind: 'shared',
  owner: null,
  ...extra,
})

function build(path: string, entry?: ApiSharedCalendar) {
  return buildCalendars({
    collections: [collection(path, 'Staff')],
    subscriptions: [],
    prefs: [],
    ...(entry ? { shared: [entry] } : {}),
  })[0]!
}

describe('manage', () => {
  it('is own for a collection with an ordinary name', () => {
    // the default calendar is the person's own too, and marked: it is renamed, never deleted
    expect(build('/caldav/u/def-calendar/').manage).toEqual({ kind: 'own', default: true })
    expect(build('/caldav/u/Work/').manage).toEqual({ kind: 'own' })
  })

  it('is the group and calendar for a share the viewer manages', () => {
    const calendar = build('/caldav/u/shared-7-staff/', shared({ groupId: 3, canManage: true }))
    expect(calendar.manage).toEqual({ kind: 'group', groupId: 3, calendarId: 7 })
  })

  it('is absent when the viewer does not manage the group', () => {
    expect(
      build('/caldav/u/shared-7-staff/', shared({ groupId: 3, canManage: false })).manage,
    ).toBeUndefined()
    expect(build('/caldav/u/shared-7-staff/', shared({ groupId: 3 })).manage).toBeUndefined()
  })

  it("is absent for a person's share and for a share without a group", () => {
    const person = shared({ kind: 'personal', owner: 'Alice', groupId: null, canManage: true })
    expect(build('/caldav/u/shared-7/', person).manage).toBeUndefined()
    expect(build('/caldav/u/shared-7-staff/', shared({ canManage: true })).manage).toBeUndefined()
  })

  it('is absent for a share the server did not list', () => {
    expect(
      build('/caldav/u/shared-9-staff/', shared({ groupId: 3, canManage: true })).manage,
    ).toBeUndefined()
  })

  it('is absent for subscriptions', () => {
    const [calendar] = buildCalendars({
      collections: [],
      subscriptions: [
        {
          id: 1,
          ref: 'ics:1',
          name: 'Feed',
          url: 'https://x.org/a.ics',
          color: null,
          shared: false,
        },
      ],
      prefs: [],
    })
    expect(calendar!.manage).toBeUndefined()
  })
})

describe('the calendar of the server a collection is', () => {
  it('is the id a share names, and the decoded path of one of the own', () => {
    expect(serverCalendarOf('/caldav/u/shared-7/')).toEqual({ id: 7 })
    expect(serverCalendarOf('/caldav/u/shared-7-staff/')).toEqual({ id: 7 })
    expect(serverCalendarOf('/caldav/u/Team%20plan/')).toEqual({ path: '/u/Team plan/' })
    expect(serverCalendarOf('/caldav/u/def-calendar/')).toEqual({ path: '/u/def-calendar/' })
  })

  it('is nothing for an address that is no calendar of a home', () => {
    expect(serverCalendarOf('/caldav/u/')).toBeNull()
    expect(serverCalendarOf('/caldav/u/c/event.ics')).toBeNull()
  })
})
