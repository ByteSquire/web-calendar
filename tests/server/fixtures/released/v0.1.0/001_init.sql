-- Initial schema (design §5). Timestamps are ISO 8601 UTC text with milliseconds, set by the
-- database: created_at and updated_at by their defaults, updated_at again by the *_touch triggers.
-- Booleans are 0/1 integers. Rows that belong to a user go away with the user, except calendars:
-- they also exist in Radicale, so a user who still owns one cannot be deleted.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oidc_sub TEXT NOT NULL UNIQUE,
  username TEXT COLLATE NOCASE,
  name TEXT,
  email TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX users_username ON users (username) WHERE username IS NOT NULL;

CREATE TABLE app_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label <> ''),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX app_tokens_user_id ON app_tokens (user_id, expires_at);

CREATE TABLE calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (name <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared', 'resource')),
  owner_id INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  color TEXT,
  collection_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (kind <> 'personal' OR owner_id IS NOT NULL)
);

CREATE INDEX calendars_owner_id ON calendars (owner_id);

-- principal is the Kanidm username or group name; the two catch-all types have none.
CREATE TABLE calendar_acl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'authenticated', 'public')),
  principal TEXT,
  permission TEXT NOT NULL CHECK (permission IN ('free_busy', 'read', 'write', 'admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (principal_type IN ('user', 'group') AND principal IS NOT NULL AND principal <> '')
    OR (principal_type IN ('authenticated', 'public') AND principal IS NULL)
  )
);

CREATE UNIQUE INDEX calendar_acl_entry
  ON calendar_acl (calendar_id, principal_type, COALESCE(principal, ''));
CREATE INDEX calendar_acl_principal ON calendar_acl (principal_type, principal);

-- definition is a JSON list of calendar refs (a calendars.id, an ical_subscriptions.id or an
-- external calendar URL) with colors; owner_id is NULL for views that belong to nobody.
CREATE TABLE views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (name <> ''),
  icon TEXT,
  owner_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  definition TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(definition)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX views_owner_id ON views (owner_id);
CREATE INDEX views_is_admin ON views (is_admin) WHERE is_admin = 1;

-- calendar_ref is a calendars.id, an ical_subscriptions.id or an external calendar URL, as in views.
CREATE TABLE calendar_prefs (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  calendar_ref TEXT NOT NULL CHECK (calendar_ref <> ''),
  color TEXT,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, calendar_ref)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (name <> ''),
  color TEXT,
  owner_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX categories_owner_name ON categories (COALESCE(owner_id, 0), name COLLATE NOCASE);

CREATE TABLE filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'category', 'status')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX filters_owner_id ON filters (owner_id);

-- owner_id is NULL for subscriptions shared with everyone.
CREATE TABLE ical_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  url TEXT NOT NULL CHECK (url <> ''),
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX ical_subscriptions_owner_id ON ical_subscriptions (owner_id);

CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL UNIQUE REFERENCES calendars (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  type TEXT NOT NULL CHECK (type IN ('room', 'car', 'equipment')),
  location TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A statement that does not set updated_at itself gets the current time.
CREATE TRIGGER users_touch AFTER UPDATE ON users
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER app_tokens_touch AFTER UPDATE ON app_tokens
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE app_tokens SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER calendars_touch AFTER UPDATE ON calendars
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE calendars SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER calendar_acl_touch AFTER UPDATE ON calendar_acl
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE calendar_acl SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER views_touch AFTER UPDATE ON views
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE views SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER calendar_prefs_touch AFTER UPDATE ON calendar_prefs
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE calendar_prefs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE user_id = NEW.user_id AND calendar_ref = NEW.calendar_ref;
END;

CREATE TRIGGER categories_touch AFTER UPDATE ON categories
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE categories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER filters_touch AFTER UPDATE ON filters
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE filters SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER ical_subscriptions_touch AFTER UPDATE ON ical_subscriptions
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ical_subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER resources_touch AFTER UPDATE ON resources
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE resources SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
