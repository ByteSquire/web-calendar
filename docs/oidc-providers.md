# OIDC providers

The app takes its sign-in from an OpenID Connect provider. Two are **proven against the real
product**: Kanidm (the live browser suite, 40 tests) and Keycloak 26.8.1 (an integration test with real
tokens, `tests/integration/keycloak.integration.test.ts`). Other providers are expected to work if they
meet the requirements below, but nobody has run them; the notes on them are from their documentation.
"Proven" covers the sign-in and token checks. Groups are proven on Kanidm only: the live browser suite
signs in with the real Kanidm, an admin imports a real group (`idp_team`) and its member appears in
the group file; Keycloak's claim is covered by the parser tests with a fixture shaped like it, and
no groups import has been run against a live Keycloak.

## What the app needs from a provider

1. **Discovery.** `<issuer>/.well-known/openid-configuration` answers with JSON of at most 64 KiB, and
   its `issuer` is `NUXT_OIDC_ISSUER` **character for character** (a trailing slash included: Authentik,
   Auth0 and Entra v1 have one). It names the `jwks_uri` and, for the admin check and the groups, the
   `userinfo_endpoint`. For an https issuer both must be https URLs without credentials. The server
   reaches it over https; plain http is accepted only for an http issuer, which `validate-config`
   refuses in production. **The `jwks_uri` must be on the issuer's host** (the keys decide who may
   sign in), unless the operator names the host in `NUXT_OIDC_JWKS_HOSTS` (exact names, empty by
   default, a warning at every start); the userinfo endpoint may be elsewhere. Kanidm, Keycloak,
   Auth0 and Entra v2 were checked and comply. Entra v1 (issuer `sts.windows.net`, keys at
   `login.microsoftonline.com`) and Google (keys at `www.googleapis.com`) do not, and are refused with
   a log line that names the setting. Amazon Cognito's newer issuer form (`issuer-cognito-idp...`)
   could not be checked.
2. **Access tokens are signed JWTs.** An opaque access token cannot be checked here (no introspection).
   The algorithm is asymmetric: `RS256/384/512`, `PS256/384/512`, `ES256/384/512` or `EdDSA`; RSA keys
   have at least 2048 bits. Every token names its key in the `kid` header, and the key is in the set at
   `jwks_uri`. `none` and `HS*` are never accepted, and a key only verifies the algorithms its own type
   allows. A provider that signs with a shared secret (Authentik without a signing key, an Auth0 API set
   to HS256) cannot be used.
3. **The token is an access token.** Header `typ` is absent, `at+jwt` or `JWT`; payload `typ` is absent
   or `Bearer` (Keycloak tags its ID, refresh and logout tokens differently); `token_use`, if present,
   is `access` (Cognito).
4. **The token is for us.** It names an allowed client in `client_id`, `azp`, `cid` or `appid`, or its
   `aud` holds the client id or a value of `NUXT_OIDC_AUDIENCE`. A token of another client of the same
   provider is refused.
5. **The token carries the scope** `NUXT_OIDC_REQUIRED_SCOPE` (default `caldav`), in `scope` (a
   space-separated string) or `scp` (a string or an array). ID tokens have none, which is what keeps
   them out where nothing else tells them apart.
6. **A public client with the authorization code flow and PKCE** for the browser, with the app's
   origin as redirect URL. The browser asks for the scopes of `NUXT_OIDC_SCOPE`.
   **It needs a refresh token** to renew the access token: without one the sign-in expires with the
   first access token and the app asks the person to sign in again (design §6). Kanidm and Keycloak
   issue one for the default scopes. Providers that issue it only for **`offline_access`** (as far
   as known Zitadel, Okta, Auth0 and recent Authentik versions; Auth0 and Okta also want refresh-token
   rotation turned on for a browser client) need that scope added to `NUXT_OIDC_SCOPE`; this was
   not run here. How long the refresh token lasts is the provider's: Keycloak ties it to its own
   session (30 minutes idle and 10 hours by default), Entra gives a browser client 24 hours (both
   from their documentation, not run).
7. **Groups, for the admin check and for imported groups.** The provider sends the person's groups in a
   claim, in the userinfo answer or in the access token. Signing in works without it, but nobody is an
   admin and no group can be imported. How the app reads it, and what each provider sends, is under
   [Groups](#groups).
8. **A user id (`sub`) that is stable and safe as a Radicale user name:** printable ASCII without a
   space, 1 to 255 characters, none of `/ \ : ' " * ? ,`, at most one `@` and not at either end, not
   starting with `.`, not ending with `~`. Capitals are kept and tell users apart. The ids the app uses
   for its own accounts (`_resources`, anything starting with `_group-`, and the entries of
   `NUXT_SHARING_SHARED_OWNERS`) are refused.

The settings are in the README (`NUXT_OIDC_*`). Several allowed clients (`NUXT_OIDC_ALLOWED_CLIENTS`)
share the issuer, except with Kanidm, which has one issuer per client: when the issuer ends with the
app's own client id, another client's issuer is that with the last segment replaced.

## Groups

The app has no account at the provider and polls nothing. It reads the groups claim of a person when
they sign in, keeps the groups it sees as **candidates**, and an administrator picks which candidates
to import on the Groups page. Design: [design.md](design.md) §6 and §8; trust and limits:
[security-review.md](security-review.md) §7.2.

**Where the claim comes from.** The claim is named by `NUXT_OIDC_GROUPS_CLAIM` (default `groups`) and
looked up exactly as written, so `cognito:groups`, `https://example.com/groups` or
`urn:zitadel:iam:org:project:roles` work. It is read from the **userinfo answer** for the caller's own
token (the `userinfo_endpoint` of the discovery document), and from the **signature-verified access
token** only where userinfo cannot give groups: the provider has no userinfo endpoint, userinfo answers
200 without the claim, or its endpoint is on another origin than the issuer and refuses the token with
401 or 403 (Entra's is Microsoft Graph). A 401 from the issuer's own origin never falls back (a revoked
Kanidm token still verifies locally and only userinfo notices), and an error, a timeout or a 5xx
leaves the groups unknown. The claim may be an array of strings, an object (its keys whose value is not
`false`, `null`, `0` or empty are the groups, which is Zitadel's roles) or one string; an empty array
means "no groups"; anything else counts as no claim, and a missing claim changes nothing.

**When.** At each sign-in to the web app (`/api/me`), and in the background, at most every five minutes
per person, when a calendar app calls `/caldav/` with an OIDC bearer token. The second needs that token
to be able to fetch the groups: the calendar app's client has to be granted the groups scope (Kanidm) or
the group mapper (Keycloak) or the equivalent. Without it the claim is absent and nothing changes, so
that person's groups stay as their last web sign-in left them. A login with an app token never refreshes
anything.

**How an entry becomes a group.** A group has a _key_, which identifies it at the provider, and a _name_,
which is what the app shows and what rules and Radicale use.

| Entry in the claim                                                                            | Key       | Name                                                   |
| --------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------ |
| A UUID followed by an SPN (Kanidm `groups`), and a short name after that (with `groups_name`) | the UUID  | the short name, else the part of the SPN before `@`    |
| A UUID with no SPN after it (Entra sends bare GUIDs; or a plain-name group called like an id) | the UUID  | the UUID itself; what follows is read on its own       |
| Starts with `/` (Keycloak full path)                                                          | the path  | the segments joined by `.` (`/team/ops` is `team.ops`) |
| Contains `@` (an SPN, Kanidm `groups_spn`)                                                    | the entry | the part before the `@`                                |
| Anything else (Authentik, Authelia, Okta, Cognito, Auth0, Zitadel)                            | the entry | the entry                                              |

A name is cleaned to what Radicale's group file takes: letters, digits, `_`, `.` and `-`, runs of other
characters become one `_`, at most 64 characters, starting with a letter or digit. Two keys that give
the same name are both marked **conflict**, and neither can be imported until one is renamed at the
provider. Names on `NUXT_OIDC_GROUPS_IGNORE` (default `idm_*,system_*,domain_*`: Kanidm's built-in
groups) are never candidates; the admin group's name and `web_calendar_users` are never offered.
**Adding an entry that matches a group imported already stops its import:** its members are taken out
at their next sign-in, so nobody reaches its calendars through it (the group, its calendars and rules
stay until an admin stops importing it; the people stay registered and keep their other groups).
Limits: entries over 255 characters are skipped and only the first 200 groups of a claim are kept; a
claim cut at 200 adds a person to groups but takes them out of none, so a person in more groups than
that is never removed from an imported group. Entra's pointer
for more than 200 groups is not an empty claim: the groups are then unknown and nothing changes.

**What an import does.** A candidate appears on the Groups page (admins only) after one of its members
has signed in. An admin imports it; the group starts with no members, and each person joins or leaves
as they sign in, because their membership of imported groups is replaced with their current claim.
Membership is as old as the person's last sign-in or refresh: a person removed at the provider keeps
the group until then. Import and "Stop importing" are the only ways a provider group gets into the app.

**Key stability.** Which providers identify a group by an id:

| Provider                                           | Key                              | Rename at the provider                                               |
| -------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| Kanidm `groups`, Entra                             | UUID / object id                 | the imported group follows (with the rules that name it)             |
| Keycloak                                           | the full path                    | a rename or a move is a **new group**; the old one loses its members |
| Kanidm `groups_name` or `groups_spn`               | name / SPN                       | a new group                                                          |
| Authentik, Authelia, Okta, Cognito, Auth0, Zitadel | the name (Zitadel: the role key) | a new group                                                          |

With a name key, a group deleted at the provider and created again with the same name lands in the
imported group of that name and **inherits its calendars and access rules**, with whoever the provider
puts in it. So who may create and rename groups at the provider is part of what the app trusts. With
Entra the shown name is the GUID, so the Groups page lists GUIDs.

**The admin group.** `NUXT_OIDC_ADMIN_GROUP` (default `calendar_admins`) is compared with every entry of
the claim, at each request, in three ways: the entry exactly as written; the part before the one `@` of an
SPN; or a Keycloak path joined by dots. Case counts, and blanks and symbols count too: a group
"calendar admins" is not `calendar_admins` (where people can name groups, a looser match would hand
out admin). So `calendar_admins` matches Kanidm's `calendar_admins@idm.example.org` and a top-level
Keycloak group (`/calendar_admins`); a group with blanks in its name is written as it is; with Entra
it has to be the group's GUID.

## Kanidm

Setup is in [kanidm-setup.md](kanidm-setup.md). The token shapes below were captured from Kanidm
1.11.2 (`tests/server/auth-kanidm-fixture.json`); the live browser suite runs against the Kanidm of
the test stack (`dev/spike-s1`):

- The issuer is `https://idm.example.org/oauth2/openid/web-calendar`; the discovery document lists
  `jwks_uri` as `<issuer>/public_key.jwk` and `userinfo_endpoint` as `<issuer>/userinfo`.
- Access tokens are ES256 JWTs, header `typ` `at+jwt`, with `client_id`, `aud` and `scope` (900 s).
  The ID token has the same issuer, keys, `aud` and `azp`, and no `typ`; its scopes are in `scopes`,
  not `scope`, so it carries no scope and is refused. The live suite proves it: the access token gets
  207 at `/caldav/` and 200 at `/api/me`, the ID token 401 at both.
- The scope map has to grant the scopes in `NUXT_OIDC_SCOPE`: `openid profile email groups caldav`.
  A client set up for an older version with `groups_name` needs the scope map updated once, or
  `NUXT_OIDC_SCOPE` set to the old list.
- Groups: the `groups` scope puts every group of the person into the userinfo answer and the ID token
  as its UUID followed by its SPN (`team@idm.example.org`), never into the access token, so userinfo is
  where the app reads them. The UUID is the key and the SPN's name part the name, so a rename at Kanidm
  follows. `groups_name` sends names and `groups_spn` SPNs only, which key by name and by SPN (a rename
  is a new group). Kanidm's own groups (`idm_*`, `system_*`, `domain_*`) are on the default ignore list.
  The parser is tested with a real Kanidm claim, and the live suite imports a real group (see the
  top of this page). What an admin does with the groups is in [kanidm-setup.md](kanidm-setup.md).

## Keycloak

Checked against Keycloak 26.8.1 in development mode, with realms made over the admin API
(`dev/keycloak/compose.yml` starts it; the test recreates its realms on every run).

Set up:

1. A realm. `NUXT_OIDC_ISSUER` is `https://<keycloak>/realms/<realm>`. The test Keycloak (development
   mode, host name checks off) wrote the issuer from the host name of the request. A production
   Keycloak should be given its public host name (`KC_HOSTNAME`; not tried), because tokens and
   discovery that carry another URL than the configured issuer are refused.
   Do not call the realm like the app's client: an issuer that ends with the client id looks like
   Kanidm's layout, and other allowed clients would get a realm of their name.
2. A **public client** `web-calendar` with the standard flow and PKCE (`S256`), the app's origin as
   redirect URL and web origin. Leave direct access grants off in production.
3. A client scope **`caldav`**, with "Include in token scope" on, as a default scope of the client.
4. A client scope **`groups`** with a **Group Membership** mapper: token claim name `groups` (a name
   with a dot would nest, from Keycloak's source, not tried, so use a plain one), "Add to userinfo" **on** (the app reads the groups
   there) and "Add to access token" on (the fallback). The test sets the switches explicitly; what a
   new mapper has by default was not checked. "Full group path" (on by default) writes a group as
   `/team/ops`: its key is the path and its name `team.ops`, so **a rename or a move is a new
   group**. With the path off the key is the plain name and nested groups of the same name cannot be
   told apart. A top-level admin group matches `NUXT_OIDC_ADMIN_GROUP=calendar_admins` and
   `/calendar_admins` alike. A calendar app that signs in with its own client needs the same scope
   (and the mapper) on that client, or its CalDAV calls do not refresh the groups.

What the real tokens look like (and why the verifier is built as it is):

- Access token: header `RS256`, `typ` `JWT`; payload `typ` `Bearer`, `azp` the client, **no
  `client_id`**, an `aud` that does not hold the client (the client is bound by `azp`), `scope` a
  string, `groups` as configured. The key set has an `RS256` signing key. Keycloak is also known to
  publish an `RSA-OAEP` encryption key (from its source; not seen in the test); the verifier skips
  encryption keys.
- ID token: same keys and header, payload `typ` `ID`, `azp` the client, and no `scope`. It is refused
  twice over: by `typ`, and, with that rule removed in a trial, by the missing scope.
- Refresh token: payload `typ` `Refresh`, signed with the realm's secret (`HS512`). No published key
  can check it, so it is refused as a wrong algorithm before its payload is read.
- A token of another client in the realm (`azp` another id) is refused until that
  client is in `NUXT_OIDC_ALLOWED_CLIENTS`; then both work, with their own client ids and the same
  `sub`. A token of another realm has another issuer and is refused.
- Userinfo (from the discovery document) returns `preferred_username` and `groups` as paths. The
  claim parser reads such paths in a test; the import was not run against a live Keycloak, and no
  running app server talked to it.

## Other providers

Everything in these sections is read from the providers' documentation (and, for Authentik, Authelia
and Dex, their source) and **has not been run**. The claim parser is tested with
fixtures shaped like their claims, and the token verifier with fixtures shaped like their tokens, but
no real tokens of these products were checked. Each provider also has to meet the requirements above.

### Authentik

- Access tokens are always JWTs, but only with a **signing key** on the provider (RS256, or ES* /
  EdDSA, with a `kid`); without one they use the client secret (HS256) and cannot be verified, and an
  encryption key makes them unreadable. Header `typ` is `JWT`; `aud` and `azp` are the client id;
  `scope` is a string.
- The issuer is `https://<host>/application/o/<slug>/` **with a trailing slash**, which must be
  `NUXT_OIDC_ISSUER` exactly.
- `sub`: the default (a 64-character hash) is safe. The modes that use the user name, e-mail or UPN
  are mutable and may start with `_` or `.`: a new person who gets a reused name would inherit the old
  person's calendars, and an id starting with `.` is refused here. Keep the default.
- Groups: `groups` is an array of names in userinfo (`profile` scope) and, with "Include claims in
  id_token" (on by default), in the tokens. Names are the keys: a rename is a new group.

### Authelia

- Access tokens are opaque by default. A client with `access_token_signed_response_alg: RS256` gets a
  JWT (`typ` `at+jwt`, with a `kid`). The client is in `client_id` only (no `azp`); `aud` holds only
  the audiences granted and may be missing, which is fine because `client_id` binds the token; the
  scope is an array in `scp`. `sub` is a UUIDv4. The issuer is the root URL, built from the host the
  request used, without a slash.
- Groups: `groups` is an array of names, in userinfo by default. A JWT access token carries it only
  through a `claims_policies` entry that lists it for `access_token`. Name keys.

### Zitadel

- Access tokens are opaque by default; an application can be set to issue JWTs (RS256 by default;
  RS384/512, ES* and Ed25519 exist). `azp` is the client; `aud` holds every client id of the project
  and the project id. **Not confirmed:** whether a JWT access token carries `scope` or `scp`; without
  one, the required scope fails and Zitadel cannot be used. `sub` is a numeric string. The shape of
  the discovery document was not checked.
- Groups: there is no `groups` claim. Roles are an object keyed by role name in
  `urn:zitadel:iam:org:project:roles` (an opt-in), so set `NUXT_OIDC_GROUPS_CLAIM` to that; each role
  key is a group, with the role key as its key and name.

### Okta

- A **custom authorization server** (API Access Management): JWT access tokens, RS256, a `kid`, the
  client in `cid`, `scp` as an array, the server's audience in `aud` (`api://default`). The default
  `sub` of its access token can differ from the userinfo `sub` (login-like against `00u...`), which
  fails the identity check: set the claim to the user id (unverified). The org authorization server
  gives opaque tokens and cannot be used.
- Groups: add a `groups` claim to the access token yourself (names; up to 100 groups per token). Name
  keys.

### Auth0

- A JWT access token needs an **API audience**; set a default audience on the tenant, and put the API
  identifier in `NUXT_OIDC_AUDIENCE` (the token's `aud` is that, plus the `/userinfo` URL). Signing is
  RS256 (an API set to HS256 cannot be used). `azp` or `client_id`, `scope` a string. The issuer is
  `https://<tenant domain>/` **with a trailing slash**. `sub` looks like `auth0|123` and is accepted.
- Groups: Auth0 has none built in. An Action adds a **namespaced** claim (`groups` itself is reserved),
  for example `https://example.com/groups`, and `NUXT_OIDC_GROUPS_CLAIM` names it. Userinfo has it only
  if it is in the ID token; put it in the access token too, so the fallback can use it. Name keys.

### Amazon Cognito

- JWT access tokens (RS256) with `client_id` and no `aud`, `token_use` `access`, scopes as a string.
  A custom scope is `<resource-server-id>/<scope>`, so `NUXT_OIDC_REQUIRED_SCOPE` is
  `<resource-server-id>/caldav`. The issuer is `https://cognito-idp.<region>.amazonaws.com/<pool-id>`;
  the newer form of the issuer was not checked.
- Groups: `cognito:groups`, an array of names in the access and ID token; set `NUXT_OIDC_GROUPS_CLAIM`
  to it. Name keys.

### Microsoft Entra ID

- A tenant-specific issuer, `https://login.microsoftonline.com/<tenant id>/v2.0` (the access token
  version must be 2 in the app manifest, or the issuer is `https://sts.windows.net/<tenant>/` and its
  keys are on another host, which is refused). `/common/` does not work. The access token is a JWT
  only for your **own API**: `NUXT_OIDC_SCOPE` holds the scope `api://<client-id>/caldav` instead of
  `groups`. The token lists the short scope name in `scp`, a space-separated string, so the default
  required scope `caldav` should fit (not run). `azp` is the client, `aud` the API's client id. `sub` is different for
  each application (pairwise); the stable `oid` is not used.
- Groups: Entra's userinfo is Microsoft Graph, which accepts only a Graph token and never returns
  groups. The app therefore falls back to the **access token's** `groups` claim (the manifest's
  `groupMembershipClaims`), as the userinfo refusal comes from another origin than the issuer. The
  claim holds **GUIDs**, so the Groups page lists GUIDs and `NUXT_OIDC_ADMIN_GROUP` is the GUID of the
  admin group. A person in more than 200 groups gets a pointer instead: their groups are unknown, so
  nothing changes and they are not an admin. The claim is as fresh as the token (its lifetime), not as
  a userinfo answer. The GUIDs are stable ids, so a rename follows.

### Does not work

- **Dex**: its access token has the shape of an ID token and carries no scope.
- Providers whose access tokens are opaque: Google (per its
  [token types page](https://docs.cloud.google.com/docs/authentication/token-types), which gives no
  reason), GitHub, and the Okta org server. `NUXT_OIDC_JWKS_HOSTS=www.googleapis.com` lets the keys of
  Google be fetched but does not change that: Google's access tokens cannot be verified here, and it
  has no custom scope for the required `caldav`. Supporting Google would need token introspection
  (`oauth2.googleapis.com/tokeninfo`) and a different scope rule, which are not built.
- Any provider that signs with a shared secret or encrypts the access token.
