import type { Database } from 'better-sqlite3'

// The audit log of admin actions (migration 005). Append-only; `details` is redacted here, so no
// caller can put a token into the log by mistake.

export interface AuditEntry {
  actorSub: string
  action: string
  target?: string
  details?: Record<string, unknown>
  requestId?: string
}

export interface AuditLogRow {
  id: number
  at: string
  actor_sub: string
  action: string
  target: string | null
  /** JSON text, or null. */
  details: string | null
  request_id: string | null
}

export const MAX_AUDIT_DETAILS_BYTES = 8192
export const REDACTED = '[redacted]'
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500
const MAX_DEPTH = 8
const PREVIEW_CHARS = 512

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|seal|credential/i
const BEARER = /\bbearer\s+[\w.~+/=-]+/gi
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g

function redactString(value: string): string {
  return value.replace(BEARER, REDACTED).replace(JWT, REDACTED)
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value !== 'object') return undefined
  if (seen.has(value) || depth >= MAX_DEPTH) return '[omitted]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen) ?? null)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** The JSON text for `details` (null when there are none): redacted, and capped in size. */
export function serializeAuditDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null
  const text = JSON.stringify(redact(details, 0, new WeakSet())) ?? '{}'
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_AUDIT_DETAILS_BYTES) return text
  return JSON.stringify({
    truncated: true,
    originalBytes: bytes,
    preview: Array.from(text).slice(0, PREVIEW_CHARS).join(''),
  })
}

export function recordAudit(db: Database, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (actor_sub, action, target, details, request_id)
     VALUES (@actorSub, @action, @target, @details, @requestId)`,
  ).run({
    actorSub: entry.actorSub,
    action: entry.action,
    target: entry.target ?? null,
    details: serializeAuditDetails(entry.details),
    requestId: entry.requestId ?? null,
  })
}

/** Newest first; `beforeId` continues after the last id of the previous page. */
export function listAuditEntries(
  db: Database,
  options: { limit?: number; beforeId?: number } = {},
): AuditLogRow[] {
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT),
  )
  const beforeId = options.beforeId ?? Number.MAX_SAFE_INTEGER
  return db
    .prepare<[number, number], AuditLogRow>(
      'SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?',
    )
    .all(beforeId, limit)
}
