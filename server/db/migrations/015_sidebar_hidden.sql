-- The items a user has hidden from the sidebar (FR-21), a JSON list of keys such as
-- ["calendar:dav:/caldav/<sub>/work/","resource:12"]. NULL means none. The API checks the keys
-- (shared/utils/sidebar-hidden.ts); the CHECK only keeps anything but a JSON list out of the column.

ALTER TABLE users ADD COLUMN sidebar_hidden TEXT
  CHECK (sidebar_hidden IS NULL OR (json_valid(sidebar_hidden) AND json_type(sidebar_hidden) = 'array'));
