// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listAuditEntries,
  MAX_AUDIT_DETAILS_BYTES,
  recordAudit,
  REDACTED,
} from '../../server/db/audit-log'
import { openTestDb } from './api-fixtures'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl'

let db: Database

beforeEach(() => {
  db = openTestDb()
})

afterEach(() => {
  db.close()
})

function detailsOf(id: number): unknown {
  const row = db.prepare('SELECT details FROM audit_log WHERE id = ?').get(id) as {
    details: string | null
  }
  return row.details === null ? null : JSON.parse(row.details)
}

describe('recordAudit and listAuditEntries', () => {
  it('stores an entry with a timestamp', () => {
    recordAudit(db, {
      actorSub: 'sub-alice',
      action: 'user.delete',
      target: 'user:7',
      details: { reason: 'left' },
      requestId: 'req-1',
    })
    const [row, ...rest] = listAuditEntries(db, {})
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      actor_sub: 'sub-alice',
      action: 'user.delete',
      target: 'user:7',
      request_id: 'req-1',
    })
    expect(row?.at).toMatch(ISO)
    expect(JSON.parse(row?.details ?? '')).toEqual({ reason: 'left' })
  })

  it('keeps optional fields null', () => {
    recordAudit(db, { actorSub: 'sub-alice', action: 'x' })
    expect(listAuditEntries(db, {})[0]).toMatchObject({
      target: null,
      details: null,
      request_id: null,
    })
  })

  it('lists newest first and pages with beforeId', () => {
    for (let i = 1; i <= 5; i++) recordAudit(db, { actorSub: 'sub-a', action: `a${i}` })
    const first = listAuditEntries(db, { limit: 2 })
    expect(first.map((row) => row.action)).toEqual(['a5', 'a4'])
    const next = listAuditEntries(db, { limit: 2, beforeId: first[1]?.id })
    expect(next.map((row) => row.action)).toEqual(['a3', 'a2'])
    expect(listAuditEntries(db, {})).toHaveLength(5)
  })
})

describe('redaction', () => {
  it('redacts secret-like keys at any depth, in arrays too', () => {
    recordAudit(db, {
      actorSub: 'sub-a',
      action: 'x',
      details: {
        name: 'ok',
        accessToken: 'abc',
        nested: { Password: 'p', deeper: [{ api_key: 'k', fine: 1 }, { 'x-api-key': 'k' }] },
        headers: { Authorization: 'Basic abc', Cookie: 'a=b' },
        sealed: 'zzz',
      },
    })
    expect(detailsOf(1)).toEqual({
      name: 'ok',
      accessToken: REDACTED,
      nested: {
        Password: REDACTED,
        deeper: [{ api_key: REDACTED, fine: 1 }, { 'x-api-key': REDACTED }],
      },
      headers: { Authorization: REDACTED, Cookie: REDACTED },
      sealed: REDACTED,
    })
  })

  it('redacts JWT-looking and bearer values under harmless keys', () => {
    recordAudit(db, {
      actorSub: 'sub-a',
      action: 'x',
      details: { note: JWT, list: [`sent Bearer abc.def-123 now`], plain: 'hello' },
    })
    const stored = JSON.stringify(detailsOf(1))
    expect(stored).not.toContain('eyJ')
    expect(stored).not.toContain('abc.def-123')
    expect(detailsOf(1)).toEqual({
      list: [`sent ${REDACTED} now`],
      note: REDACTED,
      plain: 'hello',
    })
  })

  it('survives cycles', () => {
    const loop: Record<string, unknown> = { a: 1 }
    loop.self = loop
    recordAudit(db, { actorSub: 'sub-a', action: 'x', details: loop })
    expect(detailsOf(1)).toEqual({ a: 1, self: '[omitted]' })
  })
})

describe('truncation', () => {
  it('replaces oversized details by a marked, valid, small JSON', () => {
    recordAudit(db, { actorSub: 'sub-a', action: 'x', details: { big: 'y'.repeat(20_000) } })
    const stored = detailsOf(1) as { truncated: boolean; originalBytes: number; preview: string }
    expect(stored.truncated).toBe(true)
    expect(stored.originalBytes).toBeGreaterThan(MAX_AUDIT_DETAILS_BYTES)
    const row = listAuditEntries(db, {})[0]
    expect(Buffer.byteLength(row?.details ?? '')).toBeLessThan(MAX_AUDIT_DETAILS_BYTES)
  })

  it('leaves details under the cap alone', () => {
    recordAudit(db, { actorSub: 'sub-a', action: 'x', details: { small: 'y'.repeat(1000) } })
    expect(detailsOf(1)).toEqual({ small: 'y'.repeat(1000) })
  })
})

describe('append-only', () => {
  it('refuses every UPDATE', () => {
    recordAudit(db, { actorSub: 'sub-a', action: 'x' })
    expect(() => db.prepare("UPDATE audit_log SET action = 'y'").run()).toThrow(/never changed/)
    expect(listAuditEntries(db, {})[0]?.action).toBe('x')
  })

  it('still allows DELETE (for a retention job)', () => {
    recordAudit(db, { actorSub: 'sub-a', action: 'x' })
    db.prepare('DELETE FROM audit_log').run()
    expect(listAuditEntries(db, {})).toEqual([])
  })

  it('rejects invalid JSON and empty actors at the database', () => {
    const insert = db.prepare('INSERT INTO audit_log (actor_sub, action, details) VALUES (?, ?, ?)')
    expect(() => insert.run('sub-a', 'x', '{oops')).toThrow()
    expect(() => insert.run('', 'x', null)).toThrow()
  })
})
