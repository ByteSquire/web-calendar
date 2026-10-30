// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  describeCheckError,
  describeCheckReason,
  describeCheckSuccess,
  summarizeIcs,
} from '../app/utils/settings/check'

const bad = (status: number, reason?: string) => ({
  statusCode: status,
  data: { statusCode: status, data: reason ? { reason } : {} },
})

describe('describeCheckReason', () => {
  it.each([
    ['blocked', /private or reserved network/],
    ['unreachable', /could not reach/],
    ['timeout', /did not answer in time/],
    ['too-large', /too large/],
    ['not-ical', /not return an iCal/],
    ['http-404', /HTTP 404 \(not found\)/],
    ['http-403', /HTTP 403 \(access denied\)/],
    ['http-401', /HTTP 401 \(sign-in required\)/],
    ['http-500', /^The address answered with HTTP 500\.$/],
    ['something-new', /could not be fetched/],
    ['http-4', /could not be fetched/],
  ])('%s', (reason, pattern) => {
    expect(describeCheckReason(reason)).toMatch(pattern)
  })
})

describe('describeCheckError', () => {
  it('words the reason of a 502', () => {
    expect(describeCheckError(bad(502, 'timeout'))).toBe('The address did not answer in time.')
  })

  it('does not blame the address for a 502 without a reason or another server error', () => {
    expect(describeCheckError(bad(502))).toBe('The calendar could not be fetched.')
    expect(describeCheckError(bad(500))).toBe('The calendar could not be fetched.')
  })

  it('says when the subscription is gone, the user is signed out or the server is unreachable', () => {
    expect(describeCheckError(bad(404))).toMatch(/no longer exists/)
    expect(describeCheckError(bad(401))).toMatch(/signed out/)
    expect(describeCheckError(new TypeError('Failed to fetch'))).toMatch(/could not be reached/)
  })

  it('never repeats the address', () => {
    const error = { statusCode: 502, data: { data: { reason: 'unreachable' }, url: 'https://x/s' } }
    expect(describeCheckError(error)).not.toContain('https://')
  })
})

describe('summarizeIcs', () => {
  const calendar = (events: number, eol = '\r\n') =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...Array.from({ length: events }, (_, index) => [
        'BEGIN:VEVENT',
        `UID:${index}@example.org`,
        'SUMMARY:Meeting',
        'END:VEVENT',
      ]).flat(),
      'END:VCALENDAR',
      '',
    ].join(eol)

  it('counts the events without parsing and measures the size in bytes', () => {
    const text = calendar(3)
    expect(summarizeIcs(text)).toEqual({ events: 3, bytes: new TextEncoder().encode(text).length })
  })

  it.each([
    ['no events', calendar(0), 0],
    ['LF line ends', calendar(2, '\n'), 2],
    ['a header that only mentions VEVENT', 'X-NOTE:BEGIN:VEVENT\r\n', 0],
    ['an indented (folded) line', 'DESCRIPTION:a\r\n BEGIN:VEVENT\r\n', 0],
    ['an empty file', '', 0],
  ])('%s', (_name, text, events) => {
    expect(summarizeIcs(text).events).toBe(events)
  })

  it('measures bytes, not characters', () => {
    expect(summarizeIcs('Ä').bytes).toBe(2)
  })
})

describe('describeCheckSuccess', () => {
  it('says that it works, how many events and how big', () => {
    const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    expect(describeCheckSuccess(text)).toBe('Works: 1 event, 58 bytes.')
    expect(describeCheckSuccess('')).toBe('Works: 0 events, 0 bytes.')
  })
})
