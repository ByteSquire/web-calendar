-- What v0.6.0 adds to a database (migration 015: the items a user hid from the sidebar). Applied
-- after the data of v0.1.0 to v0.4.0 and the migrations, by tests/server/db-upgrade-released.test.ts.
-- alice (user 1) hid a calendar and a view; bob (user 2) hid nothing (NULL).
UPDATE users SET sidebar_hidden = '["calendar:dav:/caldav/sub-alice/work/","view:2"]' WHERE id = 1;
