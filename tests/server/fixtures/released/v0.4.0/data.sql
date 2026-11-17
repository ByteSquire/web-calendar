-- Rows that v0.4.0 adds to a database (migration 014: a mode for every filter and the kind person).
-- Applied after the data of v0.1.0 to v0.3.0 and the migrations, by
-- tests/server/db-upgrade-released.test.ts. Filter 1 (alice's "Standups") is from v0.1.0.
INSERT INTO filters (id, owner_id, name, kind, value, mode) VALUES
  (2, 1, 'Not Sam', 'person', '["Sam"]', 'hide'),
  (3, 2, 'Offsites', 'text', 'offsite', 'only');
