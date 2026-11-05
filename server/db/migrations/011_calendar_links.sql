-- Calendar links (design §8, "Calendar links"): a person makes a read-only link to one calendar they
-- can view, protected by a password, for people without an account. The link is read as its maker:
-- `collection_path` is the calendar in the maker's own home (`/<sub>/<collection>/`, decoded), and
-- every read goes to Radicale as the maker, so a share or a membership that ends ends the link too.
--
-- Only hashes are stored: `slug_hash` is the SHA-256 (hex) of the random part of the address, which
-- is shown once when the link is made; `password_hash` is scrypt with its parameters and salt
-- (server/utils/links/password.ts). The calendar's name and colour are a copy taken when the link is
-- made, for the page and the list.
CREATE TABLE calendar_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  collection_path TEXT NOT NULL
    CHECK (
      length(collection_path) BETWEEN 5 AND 500
      AND substr(collection_path, 1, 1) = '/'
      AND substr(collection_path, -1) = '/'
      AND length(collection_path) - length(replace(collection_path, '/', '')) = 3
    ),
  calendar_name TEXT NOT NULL CHECK (length(calendar_name) BETWEEN 1 AND 200),
  calendar_color TEXT
    CHECK (calendar_color IS NULL OR calendar_color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  slug_hash TEXT NOT NULL UNIQUE CHECK (length(slug_hash) = 64 AND slug_hash NOT GLOB '*[^0-9a-f]*'),
  password_hash TEXT NOT NULL CHECK (password_hash GLOB 'scrypt$*'),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX calendar_links_user_id ON calendar_links (user_id);

CREATE TRIGGER calendar_links_touch AFTER UPDATE ON calendar_links
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE calendar_links SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
