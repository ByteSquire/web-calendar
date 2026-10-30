-- External CalDAV accounts (FR-8, design §5, §6). The row holds the non-secret part of an account:
-- where it is, how it logs in, and the user name. The password is never stored; the browser keeps
-- a SEALED copy (server/utils/external/seal.ts). `origin` is derived from `url` by the server
-- (`new URL(url).origin`: lower-case scheme, host and non-default port) and is the only address the
-- proxy ever talks to for this account; the seal is bound to it. The limit per user is enforced by
-- the application (MAX_EXTERNAL_ACCOUNTS in shared/types/external.ts).

CREATE TABLE external_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  url TEXT NOT NULL CHECK (url <> ''),
  origin TEXT NOT NULL CHECK (origin LIKE 'http://_%' OR origin LIKE 'https://_%'),
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'basic')),
  username TEXT,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, url),
  CHECK (origin = lower(origin)),
  -- A login has a user name, an account without one has none.
  CHECK ((auth_mode = 'basic') = (username IS NOT NULL AND username <> ''))
);

CREATE TRIGGER external_accounts_touch AFTER UPDATE ON external_accounts
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE external_accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
