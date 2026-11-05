-- Rows that v0.2.1 adds to a database (migrations 010 to 012: the sidebar order and calendar
-- links). Applied after v0.1.0/data.sql, v0.2.0/data.sql and the migrations, by
-- tests/server/db-upgrade-released.test.ts. Users 1 and 2 are alice and bob; calendar 4 is the
-- group calendar of v0.2.0.
UPDATE users SET sidebar_order = '["filters","views","calendars","resources","categories"]'
  WHERE id = 1;

-- A link made in Settings to an own calendar (011 columns, defaults of 012), one made in Settings
-- to a calendar of the access page through a share, one an admin made there (reads as the owner,
-- busy times only), and one from before 012 with no sealed copy of its address and password.
INSERT INTO calendar_links
  (id, user_id, collection_path, calendar_name, calendar_color, label, slug_hash, password_hash,
   last_used_at, level, reads_as, calendar_id, secret_sealed) VALUES
  (1, 1, '/sub-alice/work/', 'Work', '#1d4ed8', 'For the parents',
   '1111111111111111111111111111111111111111111111111111111111111111',
   'scrypt$32768$8$1$c2FsdA$aGFzaA', '2026-11-04T18:00:00.000Z', 'read', 'maker', NULL,
   's1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  (2, 2, '/sub-bob/shared-4/', 'Staff calendar', '#7c3aed', 'Front desk',
   '2222222222222222222222222222222222222222222222222222222222222222',
   'scrypt$32768$8$1$c2FsdA$aGFzaA', NULL, 'free_busy', 'maker', 4,
   's1.2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
  (3, 1, '/_group-2/staff/', 'Staff calendar', '#7c3aed', 'Reception',
   '3333333333333333333333333333333333333333333333333333333333333333',
   'scrypt$32768$8$1$c2FsdA$aGFzaA', NULL, 'free_busy', 'owner', 4,
   's1.1.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');

INSERT INTO calendar_links
  (id, user_id, collection_path, calendar_name, calendar_color, label, slug_hash, password_hash)
  VALUES
  (4, 1, '/sub-alice/work/', 'Work', NULL, 'Old link',
   '4444444444444444444444444444444444444444444444444444444444444444',
   'scrypt$32768$8$1$c2FsdA$aGFzaA');
