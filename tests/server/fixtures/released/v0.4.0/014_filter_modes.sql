-- Filters (FR-5) get a mode and a fourth kind (design §5 "filters", §9 "Filters"). `mode` says what a
-- filter does with the events it matches: `only` shows just those, `hide` hides them. Until now a
-- status filter hid its status and the other kinds showed only what they matched, so the rows keep
-- that meaning. The kind `person` matches who organised or created an event, else the owner of its
-- calendar. SQLite cannot change a CHECK in place, so the table is built anew with the same rows and
-- ids; nothing refers to it.
CREATE TABLE filters_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'category', 'status', 'person')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  mode TEXT NOT NULL DEFAULT 'only' CHECK (mode IN ('only', 'hide'))
);

INSERT INTO filters_new (id, owner_id, name, kind, value, created_at, updated_at, mode)
SELECT id, owner_id, name, kind, value, created_at, updated_at,
  CASE kind WHEN 'status' THEN 'hide' ELSE 'only' END
FROM filters;

-- Ids are never used again (design §5), also those of filters deleted before.
DELETE FROM sqlite_sequence WHERE name = 'filters_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'filters_new', seq FROM sqlite_sequence WHERE name = 'filters';

DROP TABLE filters;
ALTER TABLE filters_new RENAME TO filters;

CREATE INDEX filters_owner_id ON filters (owner_id);

CREATE TRIGGER filters_touch AFTER UPDATE ON filters
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE filters SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
