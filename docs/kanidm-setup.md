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

## 4. Test users in development only

The test stack relaxes the credential policy so users can log in with a password alone:

```sh
kanidm group account-policy credential-type-minimum idm_all_persons any
```

Do not do this on a real instance.
