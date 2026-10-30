// @vitest-environment node
// The sentences a failed write shows and the flags that drive the UI (reload, close the form).
import { describe, expect, it } from 'vitest'
import { DavError, type DavErrorKind } from '../app/utils/caldav/errors'
import { EditError, type EditErrorCode } from '../app/utils/ical/write-types'
import {
  CHANGED_BY_SOMEONE_ELSE,
  describeWriteError,
  isNotFoundError,
  type WriteAction,
} from '../app/utils/writes/messages'

const dav = (kind: DavErrorKind) => new DavError(kind, `${kind} (test)`)

describe('describeWriteError: transport errors', () => {
  const rows: [DavErrorKind, WriteAction, string, { reload: boolean; closeForm: boolean }][] = [
    [
      'unauthorized',
      'create',
      'Your sign-in expired. Sign in again.',
      { reload: false, closeForm: false },
    ],
    [
      'unauthorized',
      'edit',
      'Your sign-in expired. Sign in again.',
      { reload: false, closeForm: false },
    ],
    [
      'forbidden',
      'create',
      "You can't write to this calendar.",
      { reload: false, closeForm: false },
    ],
    [
      'forbidden',
      'delete',
      "You can't write to this calendar.",
      { reload: false, closeForm: false },
    ],
    ['conflict', 'edit', CHANGED_BY_SOMEONE_ELSE, { reload: true, closeForm: true }],
    ['conflict', 'delete', CHANGED_BY_SOMEONE_ELSE, { reload: true, closeForm: true }],
    [
      'conflict',
      'create',
      'The calendar service could not save the event because of a conflict. Try again.',
      { reload: false, closeForm: false },
    ],
    [
      'not-found',
      'edit',
      'This event no longer exists. The calendar has been reloaded.',
      { reload: true, closeForm: true },
    ],
    [
      'not-found',
      'delete',
      'This event was already deleted. The calendar has been reloaded.',
      { reload: true, closeForm: true },
    ],
    [
      'not-found',
      'create',
      'This calendar no longer exists. Reload the page and choose another calendar.',
      { reload: true, closeForm: false },
    ],
    [
      'exists',
      'create',
      'An event with this id already exists. Try again.',
      { reload: false, closeForm: false },
    ],
    [
      'unavailable',
      'edit',
      'The calendar service is busy or down. Try again in a moment.',
      { reload: false, closeForm: false },
    ],
    [
      'network',
      'create',
      'The calendar service is not reachable. Check your connection and try again.',
      { reload: false, closeForm: false },
    ],
    [
      'aborted',
      'edit',
      'The request was cancelled. Try again.',
      { reload: false, closeForm: false },
    ],
    [
      'bad-response',
      'edit',
      'The calendar service gave an unexpected answer. The calendar has been reloaded; check whether the change was saved.',
      { reload: true, closeForm: true },
    ],
    [
      'rejected',
      'create',
      'The calendar service did not accept this change. Check the details and try again.',
      { reload: false, closeForm: false },
    ],
  ]

  it.each(rows)('%s while trying to %s', (kind, action, message, flags) => {
    const failure = describeWriteError(dav(kind), action)
    expect(failure).toMatchObject({ kind, message, ...flags })
    expect(failure.detail).toBe(`${kind} (test)`)
  })

  it('covers every kind of DavError', () => {
    const covered = new Set(rows.map(([kind]) => kind))
    const all: DavErrorKind[] = [
      'unauthorized',
      'forbidden',
      'not-found',
      'conflict',
      'exists',
      'unavailable',
      'network',
      'aborted',
      'bad-response',
      'rejected',
    ]
    expect(all.filter((kind) => !covered.has(kind))).toEqual([])
  })
})

describe('describeWriteError: writer errors', () => {
  const edit = (code: EditErrorCode, message = `${code} (test)`) => new EditError(code, message)

  it('passes the words of invalid input through', () => {
    expect(
      describeWriteError(edit('invalid-input', 'The event ends before it starts.'), 'edit'),
    ).toMatchObject({
      kind: 'invalid-input',
      message: 'The event ends before it starts.',
      reload: false,
    })
  })

  it('reloads for an occurrence that is gone', () => {
    expect(describeWriteError(edit('unknown-instance'), 'delete')).toMatchObject({
      kind: 'unknown-instance',
      reload: true,
      closeForm: true,
    })
  })

  it('explains an event it cannot read', () => {
    const failure = describeWriteError(edit('unparseable'), 'edit')
    expect(failure.kind).toBe('unparseable')
    expect(failure.message).toMatch(/can't read/)
  })

  it('points to single occurrences for a series that cannot be changed as a whole', () => {
    const all = describeWriteError(edit('unsupported'), 'edit', { scope: 'all' })
    expect(all.message).toMatch(/Edit single occurrences/)
    expect(all.message).toMatch(/"This and following events"/)
    expect(all.closeForm).toBe(false)
  })

  it('gives the writer reason when the choice is not "all events"', () => {
    const other = describeWriteError(edit('unsupported', 'The time zone X is unknown.'), 'edit', {
      scope: 'this',
    })
    expect(other.message).toBe('The time zone X is unknown.')
  })
})

describe('describeWriteError: a split series that was written half', () => {
  it('names the duplicates and the cause', () => {
    const conflict = describeWriteError(dav('conflict'), 'edit', { partial: true })
    expect(conflict).toMatchObject({ kind: 'partial', reload: true, closeForm: true })
    expect(conflict.message).toMatch(/may now appear twice/)
    expect(conflict.message).toMatch(/because someone else changed it/)
    const network = describeWriteError(dav('network'), 'edit', { partial: true })
    expect(network.message).toMatch(/could not be reached/)
    const other = describeWriteError(dav('rejected'), 'edit', { partial: true })
    expect(other.message).not.toMatch(/because/)
  })
})

describe('describeWriteError: anything else', () => {
  it('does not leak a technical message', () => {
    const failure = describeWriteError(new TypeError('x is not a function'), 'edit')
    expect(failure).toMatchObject({ kind: 'unknown', reload: false, closeForm: false })
    expect(failure.message).not.toMatch(/function/)
    expect(failure.detail).toBe('x is not a function')
    expect(describeWriteError('boom', 'delete').message).toMatch(/deleting/)
  })
})

describe('isNotFoundError', () => {
  it('only matches a not-found DavError', () => {
    expect(isNotFoundError(dav('not-found'))).toBe(true)
    expect(isNotFoundError(dav('conflict'))).toBe(false)
    expect(isNotFoundError(new Error('404'))).toBe(false)
  })
})
