// Turning a category into a status: the rewrite of one resource (which events, what stays), and the
// search and the conversion over the calendars the person can change, with a stand-in CalDAV client.
import { describe, expect, it, vi } from 'vitest'
import { DavError } from '../app/utils/caldav/errors'
import type { DavObject } from '../app/utils/caldav/types'
import { categoryToStatus, hasCategory } from '../app/utils/ical/category-status'
import {
  convertCategoryEvents,
  findCategoryEvents,
  type CategoryStatusClient,
} from '../app/utils/writes/category-status'
import type { Calendar } from '../shared/types/calendar'

const ctx = {
  displayTimeZone: 'Europe/Berlin',
  orgTimeZone: 'Europe/Berlin',
  now: new Date('2026-11-06T12:00:00Z'),
}

const event = (lines: string[], extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//old system//EN',
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTAMP:20200101T000000Z',
    'DTSTART:20200101T100000Z',
    'DTEND:20200101T110000Z',
    'SUMMARY:Lunch',
    'X-OLD-SYSTEM:kept',
    ...lines,
    'END:VEVENT',
    ...extra,
    'END:VCALENDAR',
    '',
  ].join('\r\n')

describe('one resource', () => {
  it('finds the category by its exact name, in any letter case, not a longer one', () => {
    expect(hasCategory(event(['CATEGORIES:Work,TENTATIVE']), 'tentative', ctx)).toBe(true)
    expect(
      hasCategory(event(['CATEGORIES:Work', 'CATEGORIES: Tentative ']), 'Tentative', ctx),
    ).toBe(true)
    expect(hasCategory(event(['CATEGORIES:Tentative2']), 'Tentative', ctx)).toBe(false)
    expect(hasCategory(event([]), 'Tentative', ctx)).toBe(false)
  })

  it('sets the status, takes the category away and keeps everything else', () => {
    const next = categoryToStatus(
      event(['CATEGORIES:Work,Tentative', 'STATUS:CONFIRMED', 'SEQUENCE:2']),
      'tentative',
      'tentative',
      { removeCategory: true },
      ctx,
    )!
    expect(next).toContain('STATUS:TENTATIVE')
    expect(next).not.toContain('STATUS:CONFIRMED')
    expect(next).toMatch(/CATEGORIES:Work\r\n/)
    expect(next).not.toMatch(/CATEGORIES:.*Tentative/)
    expect(next).toContain('X-OLD-SYSTEM:kept')
    expect(next).toContain('SEQUENCE:3')
    expect(next).toContain('LAST-MODIFIED:20261106T120000Z')
  })

  it('keeps the category when asked, and drops CATEGORIES when it was the only one', () => {
    const kept = categoryToStatus(
      event(['CATEGORIES:Confirmed']),
      'Confirmed',
      'confirmed',
      { removeCategory: false },
      ctx,
    )
    // already confirmed (no STATUS means confirmed) and the category stays: nothing to do
    expect(kept).toBeNull()
    const only = categoryToStatus(
      event(['CATEGORIES:Confirmed', 'STATUS:TENTATIVE']),
      'Confirmed',
      'confirmed',
      { removeCategory: true },
      ctx,
    )!
    expect(only).toContain('STATUS:CONFIRMED')
    expect(only).not.toContain('CATEGORIES')
  })

  it('changes the series and the occurrences that have the category, no other', () => {
    const series = event(
      ['RRULE:FREQ=WEEKLY;COUNT=5', 'CATEGORIES:Tentative'],
      [
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTAMP:20200101T000000Z',
        'RECURRENCE-ID:20200108T100000Z',
        'DTSTART:20200108T120000Z',
        'DTEND:20200108T130000Z',
        'SUMMARY:Lunch moved',
        'CATEGORIES:Tentative',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTAMP:20200101T000000Z',
        'RECURRENCE-ID:20200115T100000Z',
        'DTSTART:20200115T120000Z',
        'DTEND:20200115T130000Z',
        'SUMMARY:Lunch fixed',
        'STATUS:CONFIRMED',
        'END:VEVENT',
      ],
    )
    const next = categoryToStatus(series, 'Tentative', 'tentative', { removeCategory: true }, ctx)!
    expect(next.match(/STATUS:TENTATIVE/g)).toHaveLength(2)
    // the occurrence without the category keeps its own status
    expect(next).toMatch(/SUMMARY:Lunch fixed\r\nSTATUS:CONFIRMED/)
    expect(next).not.toContain('CATEGORIES')
  })

  it('without a status only takes the category away, and keeps the status the event has', () => {
    const next = categoryToStatus(
      event(['CATEGORIES:Work,Old', 'STATUS:TENTATIVE']),
      'old',
      null,
      { removeCategory: true },
      ctx,
    )!
    expect(next).toMatch(/CATEGORIES:Work\r\n/)
    expect(next).toContain('STATUS:TENTATIVE')
    expect(next).toContain('SEQUENCE:1')
    const bare = categoryToStatus(
      event(['CATEGORIES:Old']),
      'Old',
      null,
      { removeCategory: true },
      ctx,
    )!
    expect(bare).not.toContain('CATEGORIES')
    expect(bare).not.toContain('STATUS')
  })

  it('answers null for a resource without the category', () => {
    expect(
      categoryToStatus(
        event(['CATEGORIES:Work']),
        'Tentative',
        'tentative',
        { removeCategory: true },
        ctx,
      ),
    ).toBeNull()
  })
})

const calendar = (id: string, extra: Partial<Calendar> = {}): Calendar => ({
  id: `dav:/caldav/u/${id}/`,
  name: id,
  type: 'caldav',
  color: '#1d4ed8',
  defaultVisible: true,
  href: `/caldav/u/${id}/`,
  ...extra,
})

const object = (url: string, lines: string[], etag = '"1"'): DavObject => ({
  url,
  etag,
  data: event(lines),
})

describe('the search', () => {
  it('searches the calendars the person can change, keeps exact matches, and says which failed', async () => {
    const findObjectsWithCategory = vi.fn(async (url: string) => {
      if (url.includes('broken')) throw new DavError('unavailable', 'down', { status: 500 })
      return [
        object(`${url}a.ics`, ['CATEGORIES:Tentative']),
        object(`${url}b.ics`, ['CATEGORIES:Tentative2']),
      ]
    })
    const client = { findObjectsWithCategory } as unknown as CategoryStatusClient
    const answer = await findCategoryEvents(
      client,
      [
        calendar('mine'),
        calendar('shared', { readOnly: true }),
        calendar('feed', { type: 'ical', id: 'ics:1' }),
        calendar('broken'),
      ],
      'Tentative',
      ctx,
    )
    expect(findObjectsWithCategory.mock.calls.map((call) => call[0])).toEqual([
      '/caldav/u/mine/',
      '/caldav/u/broken/',
    ])
    expect(answer.found.map((entry) => entry.objects.map((o) => o.url))).toEqual([
      ['/caldav/u/mine/a.ics'],
    ])
    expect(answer.failed.map((entry) => entry.calendar.name)).toEqual(['broken'])
  })
})

describe('the conversion', () => {
  it('writes each resource with its ETag, reads one that changed meanwhile again, and goes on after a failure', async () => {
    const mine = calendar('mine')
    const found = [
      {
        calendar: mine,
        objects: [
          object('/caldav/u/mine/a.ics', ['CATEGORIES:Tentative'], '"a1"'),
          object('/caldav/u/mine/b.ics', ['CATEGORIES:Tentative'], '"b1"'),
          object('/caldav/u/mine/c.ics', ['CATEGORIES:Tentative'], '"c1"'),
        ],
      },
    ]
    const putObject = vi.fn(async ({ url, etag }: { url: string; etag?: string }) => {
      if (url.endsWith('b.ics') && etag === '"b1"') throw new DavError('conflict', 'changed')
      if (url.endsWith('c.ics')) throw new DavError('forbidden', 'no', { status: 403 })
      return { url, etag: '"new"' }
    })
    const getObject = vi.fn(async (url: string) =>
      object(url, ['CATEGORIES:Tentative,Work'], '"b2"'),
    )
    const client = { putObject, getObject } as unknown as CategoryStatusClient
    const progress: number[] = []
    const result = await convertCategoryEvents(
      client,
      found,
      'Tentative',
      'tentative',
      { removeCategory: true },
      ctx,
      (done) => progress.push(done),
    )
    expect(result.changed).toBe(2)
    expect(result.failed.map((entry) => entry.url)).toEqual(['/caldav/u/mine/c.ics'])
    expect(getObject).toHaveBeenCalledExactlyOnceWith('/caldav/u/mine/b.ics')
    const retried = putObject.mock.calls.find((call) => call[0].etag === '"b2"')![0] as {
      data: string
    }
    expect(retried.data).toMatch(/CATEGORIES:Work\r\n/)
    expect(retried.data).toContain('STATUS:TENTATIVE')
    expect(progress).toEqual([1, 2, 3])
  })
})
