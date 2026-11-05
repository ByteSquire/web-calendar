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

`web_calendar_users` is the group the scope map in section 2 grants the login scopes to, so it decides
who may sign in. The admin group's name is `NUXT_OIDC_ADMIN_GROUP` in the app. The app has its own
group of the name `web_calendar_users` (everyone who signed in within the last
`NUXT_SIGNIN_WINDOW_DAYS` days, built from sign-ins); it is not this Kanidm group, and the app never
imports a group of that name or of the admin group's name.

## 2. The app's OAuth2 client

A **public** client with PKCE for the SPA login. The server has no client of its own: it verifies the
client's JWTs with the keys Kanidm publishes.

```sh
kanidm system oauth2 create-public web-calendar 'Web Calendar' https://calendar.example.org
kanidm system oauth2 add-redirect-url web-calendar https://calendar.example.org/auth/callback
kanidm system oauth2 update-scope-map web-calendar web_calendar_users openid profile email groups caldav
kanidm system oauth2 prefer-short-username web-calendar
```

- Use the real HTTPS origin of the app. `enable-localhost-redirects` is for development only: it lets
  any program on the user's machine receive login codes.
- `caldav` is a custom scope. The gateway requires it, so only members of the mapped group can get a
  token it accepts. Kanidm accepted this scope name in the test stack.
- `groups` adds the groups, as UUID and SPN, to the ID token and the userinfo response; the app's
  default scope (`NUXT_OIDC_SCOPE`) asks for it. Both the admin check and the groups of the Groups
  page are read from there (see "Groups in the app" below). The admin check matches the SPN's part
  before the `@`, so `NUXT_OIDC_ADMIN_GROUP=calendar_admins` works.
- A public client cannot skip the consent prompt. Users see it once, and again when the scopes change.
- The issuer is `https://idm.example.org/oauth2/openid/web-calendar`; the app finds the signing keys
  through its discovery document (`<issuer>/.well-known/openid-configuration`), which names
  `<issuer>/public_key.jwk`.
- The browser talks to Kanidm itself (the discovery document and the token request), so Kanidm
  must be reachable from the user's browser under the name in the issuer. Kanidm's CORS answers
  are fine. If that name resolves to a private or loopback address while the app is on a public
  one, Chrome, Edge, Brave and Firefox (Local Network Access) block the call until the person
  allows "Apps on device" / "Device apps and services" for the app's site, and report it as a CORS
  failure. Give Kanidm a name that resolves to an address the browser reaches the usual way.

Check from the app side, as a user: the access token is an ES256 JWT valid for 900 s, `scope` contains
`caldav`, and `aud` and `client_id` equal `web-calendar`.

### Groups in the app

The app needs no Kanidm account, token or polling of its own for groups. It reads the `groups`
claim of the person's own userinfo answer when they sign in to the web app, and at most every five
minutes while a calendar app signs in to `/caldav/` with an OIDC bearer token that carries the
`groups` scope. What it does with the claim, and what it does not do, is in
[design.md](design.md) §8 (Groups).

- Kanidm's `groups` scope sends, for each group of the person, its UUID and its SPN
  (`team@idm.example.org`). The app keys the group by the UUID and names it after the SPN's part before
  the `@`, so a group renamed in Kanidm is renamed in the app and its shares follow. The built-in groups
  (`idm_*`, `system_*`, `domain_*`) are never offered; `NUXT_OIDC_GROUPS_IGNORE` changes that list.
- A group shows up on the Groups page (an admin sees "Groups from your identity provider") only after
  one of its members has signed in with the `groups` scope. An admin imports it; its members join as
  each of them signs in again, so right after an import the group is empty. Nothing is imported
  that no admin picked.
- A Kanidm group that has the app's reserved names, `web_calendar_users` (the login gate above) or the
  admin group, is not offered.

**Existing installs: update the scope map once.** An install set up with `groups_name` needs the
command in the block above (`openid profile email groups caldav`); people see the consent prompt
again because the scopes changed. Until then, either set `NUXT_OIDC_SCOPE` to
`openid profile email groups_name caldav`, which keeps working but sends only names, so the groups are
keyed by name (a rename in Kanidm is then a new group, and the old one loses its members as people
sign in); or `groups_spn`, which keys by SPN and has the same property. The UUID pairs of `groups`
are what makes a rename safe.

**If you ran the group sync.** It is gone. `NUXT_GROUP_SYNC_TOKEN`, `NUXT_GROUP_SYNC_INTERVAL_SEC`
and `NUXT_GROUP_SYNC_FILE` are ignored (the container logs a warning at start while one is set);
remove them. `NUXT_GROUPS_FILE` replaces the file path. The `calendar-sync` service account and its
API token are not used any more. Revoke the token with
`kanidm service-account api-token list calendar-sync` and
`kanidm service-account api-token destroy calendar-sync <token-uuid>` (the commands of the old
rotation runbook). Taking the account out of `idm_group_admins` and `idm_people_pii_read`
(`kanidm group remove-members <group> calendar-sync`) and deleting it
(`kanidm service-account delete calendar-sync`) are the obvious next steps; those two commands were
not run for this document.

## 3. Test users in development only

The test stack relaxes the credential policy so users can log in with a password alone:

```sh
kanidm group account-policy credential-type-minimum idm_all_persons any
```

Do not do this on a real instance.
