-- Groups (contract groups-contract.md; design §5 "Groups"). A group is either created in the app
-- (`app`, its members are edited by admins) or imported from Kanidm (`kanidm`, read-only). Both
-- sources live in this table, so authorization reads the database and never the htgroup file.
--
-- `name` is the htgroup name (isGroupName in server/utils/group-sync/format.ts) and the principal of
-- calendar_acl rules; it is unique across both sources. SQLite's GLOB checks the same shape as the
-- application, so a bad name cannot reach the group file, a Radicale path or a rule by any route.
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
    CHECK (
      length(name) BETWEEN 1 AND 64
      AND name GLOB '[A-Za-z0-9]*'
      AND name NOT GLOB '*[^-A-Za-z0-9_.]*'
    ),
  source TEXT NOT NULL CHECK (source IN ('app', 'kanidm')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER groups_touch AFTER UPDATE ON groups
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Members are stored by `sub` exactly as the identity provider sends it (any id the provider
-- chooses, case-sensitive like Radicale; isValidSubject in server/utils/auth/subject.ts checks the
-- shape), not by users.id: a member the provider lists may never have signed in. Deleting a group
-- deletes its members.
CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  sub TEXT NOT NULL CHECK (length(sub) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, sub)
);

CREATE INDEX group_members_sub ON group_members (sub);

-- A calendar a group owns: kind `shared` without a personal owner, and the group's own write rule
-- in calendar_acl. Deleting a group with calendars is refused (RESTRICT).
ALTER TABLE calendars ADD COLUMN group_id INTEGER REFERENCES groups (id) ON DELETE RESTRICT
  CHECK (group_id IS NULL OR (kind = 'shared' AND owner_id IS NULL));

CREATE INDEX calendars_group_id ON calendars (group_id);
