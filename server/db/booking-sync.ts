import type { Database } from 'better-sqlite3'

// The ctag or sync-token of a collection at the last complete look of the booking reconcile. The
// key is the collection path as the requester sees it (an own calendar or a share).

export function getSyncStamp(db: Database, collectionPath: string): string | null {
  const row = db
    .prepare<[string], { stamp: string }>(
      'SELECT stamp FROM booking_sync WHERE collection_path = ?',
    )
    .get(collectionPath)
  return row?.stamp ?? null
}

export function setSyncStamp(
  db: Database,
  collectionPath: string,
  stamp: string,
  now: Date = new Date(),
): void {
  db.prepare(
    `INSERT INTO booking_sync (collection_path, stamp, checked_at) VALUES (?, ?, ?)
     ON CONFLICT (collection_path) DO UPDATE SET stamp = excluded.stamp, checked_at = excluded.checked_at`,
  ).run(collectionPath, stamp, now.toISOString())
}

/** Forget the stamp so the next run reads the collection again. */
export function clearSyncStamp(db: Database, collectionPath: string): void {
  db.prepare('DELETE FROM booking_sync WHERE collection_path = ?').run(collectionPath)
}

/** Drops stamps of collections that no pending or approved booking points at. Returns the count. */
export function pruneSyncStamps(db: Database): number {
  return db
    .prepare(
      `DELETE FROM booking_sync WHERE collection_path NOT IN (
         SELECT event_calendar_path FROM calendar_bookings WHERE status IN ('pending', 'approved')
       )`,
    )
    .run().changes
}
