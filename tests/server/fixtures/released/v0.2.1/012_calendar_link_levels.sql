-- Calendar links get what a share has (design §8, "Calendar links"): a level, the one of the access
-- rules (`read`: everything a read share shows; `free_busy`: busy times only), and whose view they
-- show. `reads_as = 'maker'` (made in Settings) reads the calendar as its maker, in their own home;
-- `reads_as = 'owner'` (made by an admin on the access page) reads it as the principal that owns the
-- collection, the first segment of `collection_path`. `calendar_id` ties a link to the calendar of
-- the access page when there is one (an admin's link always; a link made in Settings when its path
-- is a calendar the app knows), so admins see and remove every link to it. `secret_sealed` keeps the
-- address and the password for showing them again, encrypted (server/utils/links/secret.ts); the
-- hashes of migration 011 stay what a visitor is checked against. Links made before this migration
-- have no sealed secret: they keep working, but their address and password cannot be shown.
ALTER TABLE calendar_links ADD COLUMN level TEXT NOT NULL DEFAULT 'read'
  CHECK (level IN ('read', 'free_busy'));
ALTER TABLE calendar_links ADD COLUMN reads_as TEXT NOT NULL DEFAULT 'maker'
  CHECK (reads_as IN ('maker', 'owner'));
ALTER TABLE calendar_links ADD COLUMN calendar_id INTEGER REFERENCES calendars (id) ON DELETE CASCADE;
ALTER TABLE calendar_links ADD COLUMN secret_sealed TEXT
  CHECK (secret_sealed IS NULL OR (length(secret_sealed) BETWEEN 20 AND 2000 AND secret_sealed GLOB 's1.*'));

CREATE INDEX calendar_links_calendar_id ON calendar_links (calendar_id);
