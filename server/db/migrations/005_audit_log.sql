-- Audit log of admin actions (design §8, security review §7.3). Rows are only ever added: the
-- trigger refuses every UPDATE. DELETE stays possible on purpose, for a later retention job.
-- `actor_sub` is the OIDC sub as text, not a users.id: the entry must outlive the user row.
-- `details` is JSON without secrets (server/db/audit-log.ts redacts before writing).

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_sub TEXT NOT NULL CHECK (actor_sub <> ''),
  action TEXT NOT NULL CHECK (action <> ''),
  target TEXT,
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  request_id TEXT
);

CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_actor_sub ON audit_log (actor_sub);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are never changed');
END;
