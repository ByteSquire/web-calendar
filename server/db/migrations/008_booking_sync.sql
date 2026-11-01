-- What the booking reconcile saw last in a calendar (design §5 "Reconcile on move/delete"): the
-- ctag or sync-token, so a calendar that did not change is not read again. One row per collection
-- path as the requester sees it (it starts with the home owner's sub, so it is unique per
-- requester). No foreign key: a share has no calendars row for the requester. The reconcile
-- deletes rows whose path has no pending or approved booking.
CREATE TABLE booking_sync (
  collection_path TEXT PRIMARY KEY,
  stamp TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
