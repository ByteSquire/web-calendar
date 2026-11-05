-- Rows of a database that ran the migrations of v0.1.0 (001 to 008), one or more in every table, so
-- that an upgrade has something to keep. Used by tests/server/db-upgrade-released.test.ts.
INSERT INTO users (id, oidc_sub, username, name, email, is_admin, last_seen_at, time_zone) VALUES
  (1, 'sub-alice', 'alice', 'Alice Example', 'alice@example.org', 1, '2026-11-01T08:00:00.000Z', 'Europe/Berlin'),
  (2, 'sub-bob', 'bob', 'Bob Example', NULL, 0, '2026-10-30T09:30:00.000Z', NULL);

INSERT INTO app_tokens (id, user_id, label, token_hash, expires_at, last_used_at, key_version) VALUES
  (1, 1, 'phone', 'hash-0001', '2027-01-01T00:00:00.000Z', '2026-11-01T08:00:00.000Z', 2),
  (2, 2, 'laptop', 'hash-0002', '2027-02-01T00:00:00.000Z', NULL, 1);

INSERT INTO calendars (id, name, kind, owner_id, color, collection_path) VALUES
  (1, 'Work', 'personal', 1, '#1d4ed8', '/sub-alice/work/'),
  (2, 'Team', 'shared', NULL, '#047857', '/shared/team/'),
  (3, 'Room A', 'resource', NULL, NULL, '/resources/room-a/');

INSERT INTO calendar_acl (id, calendar_id, principal_type, principal, permission, applied_at) VALUES
  (1, 2, 'authenticated', NULL, 'read', '2026-10-20T10:00:00.000Z'),
  (2, 1, 'user', 'sub-bob', 'write', NULL),
  (3, 2, 'group', 'staff', 'write', '2026-10-20T10:00:00.000Z');

INSERT INTO views (id, name, icon, owner_id, is_admin, definition) VALUES
  (1, 'All staff', 'users', NULL, 1, '[{"ref":"dav:/shared/team/","color":null}]'),
  (2, 'Mine', 'calendar', 1, 0, '[{"ref":"dav:/sub-alice/work/","color":"#112233"}]');

INSERT INTO calendar_prefs (user_id, calendar_ref, color, visible) VALUES
  (1, 'dav:/sub-alice/work/', '#112233', 0);

INSERT INTO categories (id, name, color, owner_id) VALUES
  (1, 'Travel', '#b45309', NULL),
  (2, 'Focus', NULL, 1);

INSERT INTO filters (id, owner_id, name, kind, value) VALUES
  (1, 1, 'Standups', 'text', 'standup');

INSERT INTO ical_subscriptions (id, owner_id, name, url, color) VALUES
  (1, 1, 'Holidays', 'https://example.org/holidays.ics', NULL);

INSERT INTO external_accounts (id, user_id, name, url, origin, auth_mode, username, color) VALUES
  (1, 1, 'Other server', 'https://cal.example.org/dav/', 'https://cal.example.org', 'basic', 'alice', NULL);

INSERT INTO resources (id, name, type, location, capacity, description, active) VALUES
  (1, 'Room A', 'room', 'Floor 2', 8, 'Projector', 1),
  (2, 'Van', 'car', NULL, NULL, NULL, 0);

INSERT INTO resource_acl (id, resource_id, principal_type, principal, "right") VALUES
  (1, 1, 'authenticated', NULL, 'book'),
  (2, 1, 'user', 'sub-alice', 'manage');

INSERT INTO calendar_bookings
  (id, resource_id, requester_id, start_at, end_at, status, approver_id, decided_at, event_calendar_path, event_uid, block_ref) VALUES
  (1, 1, 2, '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z', 'approved', 1, '2026-11-02T12:00:00.000Z', '/sub-bob/home/', 'uid-1@example.org', 'block-ref-0000000001'),
  (2, 1, 2, '2026-11-10T09:30:00.000Z', '2026-11-10T10:30:00.000Z', 'pending', NULL, NULL, '/sub-bob/home/', 'uid-2@example.org', 'block-ref-0000000002');

INSERT INTO booking_sync (collection_path, stamp) VALUES ('/sub-bob/home/', 'stamp-1');

INSERT INTO audit_log (actor_sub, action, target, details, request_id) VALUES
  ('sub-alice', 'view.create', 'views/1', '{"name":"All staff"}', 'req-1'),
  ('sub-alice', 'resource.update', 'resources/1', NULL, NULL);
