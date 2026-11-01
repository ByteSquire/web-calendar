-- What the booking reconcile saw last in a calendar (design §5 "Reconcile on move/delete"): the
-- ctag or sync-token, so a calendar that did not change is not read again. One row per calendar;
-- the row goes with the calendar.
CREATE TABLE booking_sync (
  calendar_id INTEGER PRIMARY KEY REFERENCES calendars (id) ON DELETE CASCADE,
  stamp TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
