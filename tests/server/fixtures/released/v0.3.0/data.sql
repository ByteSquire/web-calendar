-- Rows that v0.3.0 adds to a database (migration 013: group managers). Applied after the data of
-- v0.1.0, v0.2.0 and v0.2.1 and the migrations, by tests/server/db-upgrade-released.test.ts.
-- Group 2 is staff with alice and bob, group 3 the imported idp_team with bob (v0.2.0).
UPDATE group_members SET manager = 1 WHERE group_id = 2 AND sub = 'sub-alice';
UPDATE group_members SET manager = 1 WHERE group_id = 3 AND sub = 'sub-bob';
