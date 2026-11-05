-- Groups (contract groups-contract.md; design §5 "Groups"). A group is created in the app (`app`,
-- its members are edited by admins), imported from the identity provider (`oidc`, read-only: an
-- admin picked it from the groups people brought at sign-in, and its members follow each sign-in)
-- or is the one built-in group of everyone who signed in within the window (`everyone`, no stored
-- members). All of them live in this table, so authorization reads the database and never the
-- htgroup file.
--
-- `name` is the htgroup name (isGroupName in server/utils/groups/htgroup.ts) and the principal of
-- calendar_acl rules; it is unique across the sources. SQLite's GLOB checks the same shape as the
-- application, so a bad name cannot reach the group file, a Radicale path or a rule by any route.
--
-- `external_id` is the provider's own key for an imported group: its id where the claim has one
-- (Kanidm UUID, Entra object id), else its name or path. It is what an import is matched on, so a
-- rename at the provider changes `name` and not the group.
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
    CHECK (
      length(name) BETWEEN 1 AND 64
      AND name GLOB '[A-Za-z0-9]*'
      AND name NOT GLOB '*[^-A-Za-z0-9_.]*'
    ),
  source TEXT NOT NULL CHECK (source IN ('app', 'oidc', 'everyone')),
  external_id TEXT CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((source = 'oidc') = (external_id IS NOT NULL)),
  -- The users group of the group file is the built-in group and no other: no app or imported group
  -- can take its name, and it cannot be renamed.
  CHECK ((source = 'everyone') = (name = 'web_calendar_users'))
);

CREATE UNIQUE INDEX groups_external_id ON groups (external_id) WHERE external_id IS NOT NULL;

-- The built-in group of everyone who signed in within the window (NUXT_SIGNIN_WINDOW_DAYS). It has
-- no rows in group_members: the app builds its line of the group file from `users.last_seen_at`.
-- It can be shared with but cannot own calendars, be renamed or be deleted.
INSERT INTO groups (name, source) VALUES ('web_calendar_users', 'everyone');

CREATE TRIGGER groups_touch AFTER UPDATE ON groups
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- What the identity provider's `groups` claim has shown at sign-in: the groups an admin may pick
-- from. A candidate grants nothing; members are stored only for groups an admin imported.
-- `name` is the claim's entry made safe for the group file (same shape as groups.name);
-- `conflict` is 1 when another key of the claim has the same safe name (neither can be imported
-- until the provider changes one). Rows not seen for 90 days are removed.
CREATE TABLE oidc_group_candidates (
  external_id TEXT PRIMARY KEY CHECK (length(external_id) BETWEEN 1 AND 255),
  name TEXT NOT NULL
    CHECK (
      length(name) BETWEEN 1 AND 64
      AND name GLOB '[A-Za-z0-9]*'
      AND name NOT GLOB '*[^-A-Za-z0-9_.]*'
    ),
  conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Members are stored by `sub` exactly as the identity provider sends it (any id the provider
-- chooses, case-sensitive like Radicale; isValidSubject in server/utils/auth/subject.ts checks the
-- shape), not by users.id: a person is added at their own sign-in, but an admin may also add a
-- member by hand. Deleting a group deletes its members.
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
