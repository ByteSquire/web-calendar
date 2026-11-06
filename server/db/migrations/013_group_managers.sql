-- Group managers (design §5 "Groups"): an admin names some members of a group its managers. A
-- manager changes the members of an app group and creates, renames, shares and deletes the group's
-- calendars; the other members use those calendars. The flag is a column of the membership, so a
-- person who leaves the group (an admin removes them, or the identity provider no longer lists them
-- at sign-in) is no longer its manager either; the sign-in sync adds and drops single rows, so the
-- members it keeps keep their flag. The group of everyone has no stored members and so no managers.
ALTER TABLE group_members ADD COLUMN manager INTEGER NOT NULL DEFAULT 0 CHECK (manager IN (0, 1));
