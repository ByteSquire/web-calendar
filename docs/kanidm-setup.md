# Kanidm setup

What an admin creates in Kanidm for the web calendar. The commands were run against the test stack
in `dev/spike-s1` (Kanidm 1.11.2); replace the names and the URL for production. Log in first with
an account that may manage groups and OAuth2 clients, for example
`kanidm login -D idm_admin`.

Design context: [design.md](design.md) §6 (authentication) and §8 (access control).

## 1. Groups

```sh
kanidm group create web_calendar_users   # may log in to the calendar app
kanidm group create calendar_admins      # may administer calendars and access rules
kanidm group add-members web_calendar_users alice bob
kanidm group add-members calendar_admins alice
```

The group names are configurable in the app. `web_calendar_users` also serves as the "all users"
principal when sharing a calendar with everyone.

## 2. The app's OAuth2 client

A **public** client with PKCE for the SPA login. The server has no client of its own: it verifies the
client's JWTs with the keys Kanidm publishes.

```sh
kanidm system oauth2 create-public web-calendar 'Web Calendar' https://calendar.example.org
kanidm system oauth2 add-redirect-url web-calendar https://calendar.example.org/auth/callback
kanidm system oauth2 update-scope-map web-calendar web_calendar_users openid profile email groups_name caldav
kanidm system oauth2 prefer-short-username web-calendar
```

- Use the real HTTPS origin of the app. `enable-localhost-redirects` is for development only: it lets
  any program on the user's machine receive login codes.
- `caldav` is a custom scope. The gateway requires it, so only members of the mapped group can get a
  token it accepts. Kanidm accepted this scope name in the test stack.
- `groups_name` adds group names to the ID token and the userinfo response. The test stack used
  `groups groups_name groups_spn` together; `groups_name` alone is untested.
- A public client cannot skip the consent prompt. Users see it once, and again when the scopes change.
- The issuer is `https://idm.example.org/oauth2/openid/web-calendar`; the signing keys are at
  `<issuer>/public_key.jwk`.

Check from the app side, as a user: the access token is an ES256 JWT valid for 900 s, `scope` contains
`caldav`, and `aud` and `client_id` equal `web-calendar`.

## 3. Group sync account

Radicale's group file needs the members of whole groups, refreshed every 60 s. The sync uses a
service account with a **read-only API token**:

```sh
kanidm service-account create calendar-sync 'Calendar group sync' idm_admins
kanidm group add-members idm_group_admins calendar-sync
kanidm service-account api-token generate calendar-sync 'group sync'   # read-only by default
```

The server then reads a group with `GET /v1/group/<name>` and a bearer token (the `member`
attribute lists SPNs such as `alice@idm.example.org`).

Why `idm_group_admins`: in the test stack a fresh service account **could not read groups** (the call
returned `null`), also as a member of `idm_service_desk`, and Kanidm 1.11.2 has no built-in read-only
group for it and no CLI to define a custom access profile. `idm_group_admins` grants group read and
write, so the safety net is the **token**: tokens are read-only unless generated with `--readwrite`,
and a write attempt with the read-only token returned 403 with the membership unchanged (tested).

- Never generate a `--readwrite` token for this account, and give the token an expiry (the generate
  command takes an optional RFC 3339 time) so it can be rotated.
- The account has no password, so it cannot log in; only its tokens can act.
- If you prefer least privilege over this workaround, the alternatives are Kanidm's LDAP interface
  with a service-account bind, or a future read-only built-in group (design §12, S9).

**Residual risk of `idm_group_admins`.** Whoever holds the token can read every group, and anyone who
obtains a _read-write_ token for this account (or who can add a token to it) can change any group's
members, including `calendar_admins` and the groups that gate other systems. The sync only ever sends
reads and its token is read-only, but the account is more powerful than its job. Keep the token in the
environment only: it is never logged, put into an error text or returned by the app.

**The token expires.** Generate it with an expiry of at most 90 days:

```sh
kanidm service-account api-token generate calendar-sync 'group sync <date>' 2026-12-31T00:00:00+00:00
```

**Rotation runbook** (calendar it every 60 days):

1. Generate a new token as above (the old one keeps working).
2. Put it into `NUXT_GROUP_SYNC_TOKEN` and restart the app. The log shows no `ALARM` line, and the
   group file's modified time or `htgroup.prev` shows the next run (or check
   `docker compose logs web-calendar | grep group-sync`).
3. Revoke the old one: `kanidm service-account api-token list calendar-sync`, then
   `kanidm service-account api-token destroy calendar-sync <token-uuid>`.

**Leavers.** After each good run the sync deletes the app tokens of every user who is no longer a
member of `web_calendar_users` (removed from the group, or disabled or deleted in Kanidm), and
writes one `group_sync.tokens_revoked` audit event per user. A user's sign-in with their Kanidm
account ends within minutes anyway; the app tokens are what this closes. If the users group is
empty, nobody's tokens are deleted. Without `NUXT_GROUP_SYNC_TOKEN` there is no sync, and no
removal.

**The alarm.** An HTTP 401 or 403 from Kanidm means the token expired, was revoked or lost the right.
The sync logs `[group-sync] ALARM` at error level every run and writes one audit event
`group_sync.unauthorized`. The group file stays as it was, so removed members keep access: rotate the
token at once. Five failed runs in a row (any reason) log an error and write `group_sync.failing`;
the first good run afterwards writes `group_sync.recovered`.

**Members and UUIDs.** Kanidm lists group members as SPNs and the token cannot read persons, so the app
maps each SPN to the `sub` UUID with its own `users` table (the `preferred_username` of the sign-in).
A member who has never signed in makes the run fail, with a warning naming them, until they do.

**Target state: the LDAP read-only bind.** Kanidm's LDAP interface is read-only by construction and a
service-account bind there needs no `idm_group_admins`; it also returns `entryuuid` for members. The
sync is built on the API token because adding an LDAP library is out of scope for now; replace
`server/utils/group-sync/kanidm.ts` and `members.ts` when you switch.

## 4. Test users in development only

The test stack relaxes the credential policy so users can log in with a password alone:

```sh
kanidm group account-policy credential-type-minimum idm_all_persons any
```

Do not do this on a real instance.
