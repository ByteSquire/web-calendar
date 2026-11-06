# Released schemas

One folder per release that changed the database, named by its tag: the migrations **as they were
released** (`NNN_name.sql`) and `data.sql`, rows for the tables that release added (and any new
column it filled). `tests/server/db-upgrade-released.test.ts` uses them in two ways: it compares
each file byte for byte with `server/db/migrations/`, so a migration that has shipped cannot be
edited, and it builds the database that release left, fills it, and runs the current upgrade on it.

When you make a release whose migrations no earlier release had:

1. `mkdir tests/server/fixtures/released/<tag>`, copy the new migration files into it, and write
   its `data.sql` (insert rows that exercise the new tables, and that touch every constraint).
2. Add the tag to the list in the first `describe` and a `describe('updating from <tag>')` in the
   test, with the migrations that upgrade it (`leftBy('v0.1.0', 'v0.2.0', '<tag>')`).

Pending now: `013_group_managers.sql`. Every migration up to `012_calendar_link_levels.sql` is
released (`v0.2.1` froze 010 to 012). A new migration may be edited until the release that carries
it, and is frozen here then.
