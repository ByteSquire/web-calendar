-- Rows that v0.2.0 adds to a database (migration 009: groups). Applied after v0.1.0/data.sql and
-- the migration, by tests/server/db-upgrade-released.test.ts. The group of everyone is id 1.
INSERT INTO groups (id, name, source, external_id) VALUES
  (2, 'staff', 'app', NULL),
  (3, 'idp_team', 'oidc', 'uuid-1234');

INSERT INTO group_members (group_id, sub) VALUES
  (2, 'sub-alice'),
  (2, 'sub-bob'),
  (3, 'sub-bob');

INSERT INTO oidc_group_candidates (external_id, name, conflict) VALUES
  ('uuid-5678', 'other_team', 0);

INSERT INTO calendars (id, name, kind, owner_id, color, collection_path, group_id) VALUES
  (4, 'Staff calendar', 'shared', NULL, '#7c3aed', '/_group-2/staff/', 2);
