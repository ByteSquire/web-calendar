-- The order a user keeps the sections of the sidebar in (FR-21), a JSON list of section ids such
-- as ["calendars","views"]. NULL means the default order. The API checks the ids (a list of known
-- sections without repeats); the CHECK only keeps anything but a JSON list out of the column.

ALTER TABLE users ADD COLUMN sidebar_order TEXT
  CHECK (sidebar_order IS NULL OR (json_valid(sidebar_order) AND json_type(sidebar_order) = 'array'));
