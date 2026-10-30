-- A user's own time zone (FR-32), an IANA name such as Europe/Berlin. NULL means "use the zone of
-- the browser", which is the default. The API checks the name; the CHECK only keeps out an empty one.

ALTER TABLE users ADD COLUMN time_zone TEXT CHECK (time_zone IS NULL OR time_zone <> '');
