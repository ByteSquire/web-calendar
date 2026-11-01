# S5 follow-ups: `f` on map shares, and many shares

Radicale 3.9.0 (the spike stack), 2026-11-01. Script: `dev/spike-s1/tools/s5_shares.py`
(`perms`, `scale N --members M`, `clean`). Own users only (`s5-*`); everything was deleted afterwards
(`sharing.csv` back to its original 2 lines). Labels: RUNTIME = observed, CODE = read in Radicale's
`radicale/sharing/*.py` and `radicale/app/*.py`, DEDUCED = inferred.

## 1. Permissions on map shares

Share of one calendar (`PathMapped` `/owner/cal/`) to a user, which the member then enabled and unhid.

| Permission        | create / list         | member PROPFIND cal (D0)                                                                                                  | PROPFIND D1 / GET event / `calendar-query` | `free-busy-query`                                                   | PUT / DELETE    |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- | --------------- |
| `f`               | 200, list returns `f` | 207: displayname, resourcetype, getetag/ctag, `supported-report-set` = only `free-busy-query`; privilege `read-free-busy` | **403** (no titles leak)                   | **200**, `VFREEBUSY` with `FREEBUSY;FBTYPE=BUSY` ranges, no summary | 403             |
| `r`               | 200                   | 207, privileges read + read-free-busy                                                                                     | 207 / 200 / 207, bodies readable           | 200                                                                 | 403             |
| `rw`              | 200                   | 207, + write-content                                                                                                      | all work                                   | 200                                                                 | 201 / 204 / 200 |
| `fr`, `rf`, `rwf` | 200, stored as given  | behave as `r` / `rw`                                                                                                      | as `r` / `rw`                              | 200                                                                 | as `r` / `rw`   |

RUNTIME for all rows. `r` implies free/busy (CODE: `app/base.py` `_with_implied_freebusy`). Accepted
strings: any combination of the characters `RrifWwDdOoTtMmPpEel` (CODE `rights/__init__.py`
`INTERNAL_PERMISSIONS`; RUNTIME `x` and `F` give 400, the **empty string is accepted** and stored).
Order is not normalised. Group shares get `epu` appended (CODE), the list then returns e.g. `uerp`.

Further findings (RUNTIME):

- A **user** share is not live until the member calls `enable` and `unhide` (both 200 as the member);
  before that the member's path answers 404 ("not enabled by user" in the log). Group shares need neither.
- **One map share per (source collection, user)**: a second create with another `PathOrToken` gives 409.
  A member's number of shares is bounded by the number of distinct source calendars.
- `PathMapped` must end with `/`: a single event cannot be shared (400). "Single versus whole": a share
  of a calendar works as above. A share of a whole **home** (`/owner/`) is accepted but is not usable:
  the home path itself gives 403 (`f` and `r`), and the calendar below it answers PROPFIND D0 only
  (`r`: D1 and `calendar-query` work, but GET of an event gives 403; `f`: D1 403, free-busy 200). Do not use.
- `delete` takes only `PathOrToken` (and finds the share by it); only the owner can delete (CODE).
- The member's own `list` shows the shares he receives.

Conclusion: **`f` is accepted and enforced for map shares of a calendar collection**, with the same view
as in the rights file (S5 original). The FR-18 blocked view needs no fallback.

## 2. Many shares

Local Docker, loopback, one connection per owner, `read` shares, 4 owners. Radicale idle CPU 0%, memory
91 MiB at start, 96 to 101 MiB with 500 to 2000 shares (RUNTIME `docker stats`; no growth symptom, no CPU
pinned). Median / worst of 5 runs (create: of N calls).

| Shares (members x calendars) | create per call median / worst                | `sharing.csv` | list (one owner)        | full list-and-compare, all owners | member home PROPFIND D1    |
| ---------------------------- | --------------------------------------------- | ------------- | ----------------------- | --------------------------------- | -------------------------- |
| 1                            | 2.6 / 2.6 ms                                  | +101 B        | 2.1 / 2.5 ms            | 5.7 / 76.5 ms (first call)        | 2.6 / 2.9 ms               |
| 50 (1 x 50)                  | 2.2 / 3.2 ms                                  | 5.5 kB        | 1.5 / 2.3 ms (13 rows)  | 6.5 / 7.4 ms                      | 16.1 / 16.6 ms             |
| 100 (1 x 100)                | 2.3 / 3.5 ms                                  | 10.6 kB       | 1.7 / 2.7 ms            | 7.7 / 9.3 ms                      | 35.7 / 36.2 ms             |
| 500 (1 x 500)                | 3.4 / 6.1 ms (last quarter 5.2)               | 52.6 kB       | 3.0 / 3.5 ms (125 rows) | 11.6 / 12.0 ms                    | 222 / 225 ms               |
| 500 (50 x 10)                | 4.0 / 6.9 ms                                  | 51.7 kB       | 3.4 / 4.0 ms            | 14.3 / 14.7 ms                    | 9.2 / 9.6 ms               |
| 2000 (4 x 500)               | 9.7 / 35.1 ms (last quarter 15.0); total 19 s | 209 kB        | 8.3 / 8.8 ms (500 rows) | 36.6 / 38.2 ms                    | 246 / 261 ms (500 shares)  |
| 2000 (100 x 20)              | 9.5 / 25.5 ms; total 19 s                     | 208 kB        | 8.4 / 8.8 ms            | 36.2 / 36.7 ms                    | 24.0 / 24.4 ms (20 shares) |

Plus: member `enable`+`unhide` per share 3.3 ms (50) to 16 ms (2000), worst 131 ms; a GET of an event through
a share 1.6 ms (50 shares in DB) to 12.5 ms (2000 in DB). About 100 bytes per share in the CSV.

Reading:

- **Per share cost grows with the whole database, not with the member.** CODE: `database_create_sharing` appends and
  then **rewrites the whole CSV** under a write lock, and every lookup (`database_list_sharing`, used by the map
  resolver on every request below a share path) scans the whole in-memory cache linearly. RUNTIME agrees:
  create 2.3 ms at 100 shares, ~10 ms at 2000; GET 1.6 ms to 12.5 ms; a member with 20 shares sees PROPFIND at 24 ms
  when the DB has 2000 shares, versus ~9 ms with 10 shares in a 500-share DB.
- **Member home PROPFIND D1 is the first cost to bite:** roughly linear in that member's shares
  (0.33 ms per share at 50, 0.45 ms at 500): 16 ms (50), 36 ms (100), 222 ms (500). The response is 171 kB at 500.
  (It also lists each shared calendar's properties; no per-event work.) Clients that poll the home (third-party
  calendar apps) pay this per poll.
- **Reconcile is cheap:** one `list` per owner. A full list of 2000 shares over 4 owners took 37 ms (500 rows per
  owner, 182 kB); the diff in memory is negligible. At the 5 minute interval this is not a load concern up to
  at least 2000 shares. DEDUCED: cost per owner is linear in that owner's shares, plus one request per owner (the
  API lists only the caller's own shares as owner), so 100 owners need 100 requests.
- Radicale processes requests in threads but the CSV write holds a lock (CODE), so a burst of creates is serial:
  2000 creates took 19 s (about 21 s with accepts doubled: another ~2 x 2000 writes). The initial full sync after
  a large import is the slow path; ordinary ACL edits are single calls.
- Where it degrades: not within 2000 shares on this machine. DEDUCED (quadratic create total, linear lookups):
  above ~10 000 shares creation would be 50 ms+ per call and every request below a share path pays the scan.
  Not measured.

## 3. Not checked

- Group shares at scale (`:group` with the htgroup file; the group file belongs to the user's stack).
- Real clients; concurrent writers during reconcile; the effect of the rights file's regexes (static, tiny).
- More than 2000 shares; a production-sized disk and a separate network hop.
