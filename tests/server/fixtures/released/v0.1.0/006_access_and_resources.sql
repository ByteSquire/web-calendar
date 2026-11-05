-- Access rules and resources for Phase 3 (design §5 "Resource model", security review §7.1, §7.4).
--
-- calendar_acl: principals become Kanidm identifiers (a user's `sub`, a group UUID or SPN) instead
-- of names, and `applied_at` records when Radicale confirmed the share. resources: a resource is no
-- longer a calendar, so calendar_id goes. SQLite cannot alter constraints, so both tables are
-- recreated. Old rows cannot be converted (a name is not a `sub`; a resource calendar is not a
-- resource), and nothing in the app wrote them, so a non-empty table aborts the migration instead
-- of losing data silently. Nothing references either table, so dropping them is safe.

CREATE TEMP TABLE migration_006_guard (
  acl_ok INTEGER NOT NULL
    CONSTRAINT "migration 006 refused: calendar_acl still has rows with name principals, convert or delete them first"
    CHECK (acl_ok = 1),
  resources_ok INTEGER NOT NULL
    CONSTRAINT "migration 006 refused: resources still has rows tied to a calendar, convert or delete them first"
    CHECK (resources_ok = 1)
);

INSERT INTO migration_006_guard (acl_ok, resources_ok)
SELECT NOT EXISTS (SELECT 1 FROM calendar_acl), NOT EXISTS (SELECT 1 FROM resources);

DROP TABLE migration_006_guard;

DROP TABLE calendar_acl;
DROP TABLE resources;

-- user and group principals are the Kanidm `sub` UUID, or a group UUID or SPN: printable ASCII,
-- no `/` or `\`, 1 to 255 characters (isValidSubject in server/utils/auth/subject.ts).
-- authenticated and public rows hold no principal. applied_at is NULL until Radicale confirmed.
CREATE TABLE calendar_acl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'authenticated', 'public')),
  principal TEXT,
  permission TEXT NOT NULL CHECK (permission IN ('free_busy', 'read', 'write', 'admin')),
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (
      principal_type IN ('user', 'group')
      AND principal IS NOT NULL
      AND length(principal) BETWEEN 1 AND 255
      AND principal NOT GLOB '*[^!-~]*'
      AND instr(principal, '/') = 0
      AND instr(principal, char(92)) = 0
    )
    OR (principal_type IN ('authenticated', 'public') AND principal IS NULL)
  )
);

CREATE UNIQUE INDEX calendar_acl_entry
  ON calendar_acl (calendar_id, principal_type, COALESCE(principal, ''));
CREATE INDEX calendar_acl_principal ON calendar_acl (principal_type, principal);
CREATE INDEX calendar_acl_unapplied ON calendar_acl (id) WHERE applied_at IS NULL;

CREATE TRIGGER calendar_acl_touch AFTER UPDATE ON calendar_acl
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE calendar_acl SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- A resource is a thing with metadata; its availability comes from calendar_bookings. It is
-- deactivated (active = 0), not deleted, because bookings keep pointing at it.
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (name <> ''),
  type TEXT NOT NULL CHECK (type IN ('room', 'car', 'equipment')),
  location TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER resources_touch AFTER UPDATE ON resources
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE resources SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Who may see (read), book (book) or manage (manage) a resource; manage includes book includes
-- read. The default "any authenticated user may book" is data: createResource inserts that row,
-- and a manager may remove or narrow it. `public` is not allowed.
CREATE TABLE resource_acl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'authenticated')),
  principal TEXT,
  "right" TEXT NOT NULL CHECK ("right" IN ('read', 'book', 'manage')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (
      principal_type IN ('user', 'group')
      AND principal IS NOT NULL
      AND length(principal) BETWEEN 1 AND 255
      AND principal NOT GLOB '*[^!-~]*'
      AND instr(principal, '/') = 0
      AND instr(principal, char(92)) = 0
    )
    OR (principal_type = 'authenticated' AND principal IS NULL)
  )
);

CREATE UNIQUE INDEX resource_acl_entry
  ON resource_acl (resource_id, principal_type, COALESCE(principal, ''));
CREATE INDEX resource_acl_principal ON resource_acl (principal_type, principal);

CREATE TRIGGER resource_acl_touch AFTER UPDATE ON resource_acl
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE resource_acl SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- The app database is the source of truth for booking state. start_at and end_at are UTC ISO text
-- with milliseconds (so they compare as strings). A pending booking does not block the slot, an
-- approved one does (triggers below). Orphaned is not a status: orphaned_at is set while the
-- booking event cannot be found, and the booking keeps its status (and slot) during the retries.
-- requester_id is RESTRICT like calendars.owner_id: a user with bookings is not deleted silently.
-- event_calendar_path is the collection of the booking event as the requester sees it, in the form
-- calendars.collection_path uses (decoded, '/<sub>/<name>/'): an own calendar, or a share at
-- '/<sub>/shared-<id>[-<group>]/'. It is a plain path, not a foreign key: a share or a calendar that
-- discovery has not seen yet has no calendars row for the requester, and a deleted calendar must
-- not unlink the booking. block_ref is the opaque id the availability block carries instead of the
-- booking calendar's path or UID.
CREATE TABLE calendar_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources (id) ON DELETE RESTRICT,
  requester_id INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  start_at TEXT NOT NULL
    CHECK (start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  end_at TEXT NOT NULL
    CHECK (end_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  approver_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  decided_at TEXT,
  event_calendar_path TEXT NOT NULL
    CHECK (
      length(event_calendar_path) <= 500
      AND substr(event_calendar_path, 1, 1) = '/'
      AND substr(event_calendar_path, -1) = '/'
      AND instr(event_calendar_path, '//') = 0
      AND length(event_calendar_path) - length(replace(event_calendar_path, '/', '')) = 3
    ),
  event_uid TEXT NOT NULL CHECK (event_uid <> ''),
  block_ref TEXT NOT NULL UNIQUE CHECK (length(block_ref) >= 16),
  orphaned_at TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_at > start_at)
);

CREATE INDEX calendar_bookings_slot ON calendar_bookings (resource_id, start_at, end_at);
CREATE INDEX calendar_bookings_approved_slot ON calendar_bookings (resource_id, start_at, end_at)
  WHERE status = 'approved';
CREATE INDEX calendar_bookings_requester ON calendar_bookings (requester_id, start_at);
CREATE INDEX calendar_bookings_event ON calendar_bookings (event_calendar_path, event_uid);
CREATE INDEX calendar_bookings_orphaned ON calendar_bookings (orphaned_at)
  WHERE orphaned_at IS NOT NULL;

CREATE TRIGGER calendar_bookings_touch AFTER UPDATE ON calendar_bookings
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE calendar_bookings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;

-- Two approved bookings never overlap on one resource (half-open slots: touching ends are fine).
CREATE TRIGGER calendar_bookings_no_overlap_insert BEFORE INSERT ON calendar_bookings
WHEN NEW.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approved booking overlaps another approved booking')
  WHERE EXISTS (
    SELECT 1 FROM calendar_bookings
    WHERE resource_id = NEW.resource_id AND status = 'approved'
      AND start_at < NEW.end_at AND end_at > NEW.start_at
  );
END;

CREATE TRIGGER calendar_bookings_no_overlap_update
BEFORE UPDATE OF status, start_at, end_at, resource_id ON calendar_bookings
WHEN NEW.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approved booking overlaps another approved booking')
  WHERE EXISTS (
    SELECT 1 FROM calendar_bookings
    WHERE resource_id = NEW.resource_id AND status = 'approved' AND id <> NEW.id
      AND start_at < NEW.end_at AND end_at > NEW.start_at
  );
END;

-- declined and cancelled are final.
CREATE TRIGGER calendar_bookings_final_status BEFORE UPDATE OF status ON calendar_bookings
WHEN OLD.status IN ('declined', 'cancelled') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'a declined or cancelled booking cannot change status');
END;
