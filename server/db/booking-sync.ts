import type { Database } from 'better-sqlite3'

// The ctag or sync-token of a calendar at the last complete look of the booking reconcile.

export function getSyncStamp(db: Database, calendarId: number): string | null {
  const row = db
    .prepare<[number], { stamp: string }>('SELECT stamp FROM booking_sync WHERE calendar_id = ?')
    .get(calendarId)
  return row?.stamp ?? null
}

export function setSyncStamp(
  db: Database,
  calendarId: number,
  stamp: string,
  now: Date = new Date(),
): void {
  db.prepare(
    `INSERT INTO booking_sync (calendar_id, stamp, checked_at) VALUES (?, ?, ?)
     ON CONFLICT (calendar_id) DO UPDATE SET stamp = excluded.stamp, checked_at = excluded.checked_at`,
  ).run(calendarId, stamp, now.toISOString())
}
