# OIDC providers

The app takes its sign-in from an OpenID Connect provider. Two are **proven against the real
product**: Kanidm (the live browser suite, 40 tests) and Keycloak 26.8.1 (an integration test with real
tokens, `tests/integration/keycloak.integration.test.ts`). Other providers are expected to work if they
meet the requirements below, but nobody has run them; the notes on them are from their documentation.

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
7. **Groups in userinfo.** The admin check and the groups ask the provider's userinfo endpoint with the
   caller's own token and read the `groups` claim (an array of strings).
8. **A user id (`sub`) that is stable and safe as a Radicale user name:** printable ASCII without a
   space, 1 to 255 characters, none of `/ \ : ' " * ? ,`, at most one `@` and not at either end, not
   starting with `.`, not ending with `~`. Capitals are kept and tell users apart. The ids the app uses
   for its own accounts (`_resources`, anything starting with `_group-`, and the entries of
   `NUXT_SHARING_SHARED_OWNERS`) are refused.

The settings are in the README (`NUXT_OIDC_*`). Several allowed clients (`NUXT_OIDC_ALLOWED_CLIENTS`)
share the issuer, except with Kanidm, which has one issuer per client: when the issuer ends with the
app's own client id, another client's issuer is that with the last segment replaced.

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
4. A client scope **`groups`** with a **Group Membership** mapper: token claim name `groups`, "Add to
   userinfo" **on** (the admin check reads it there) and "Add to access token" on. The test sets the
   switches explicitly; what a new mapper has by default was not checked. "Full group path" (on by
   default) writes a group as `/team/ops`. The admin group is compared with the claim entry exactly,
   so with the path on, set `NUXT_OIDC_ADMIN_GROUP=/calendar_admins`; with the path off, the plain
   name (nested groups of the same name then cannot be told apart).

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
- Userinfo (from the discovery document) returns `preferred_username` and `groups`.

## Other providers

These follow from the providers' documentation and have not been run. The app also needs them to meet
the requirements above; what usually has to be set:

- **Authentik:** access tokens are always JWTs, but only with a signing key on the provider (without
  one they use the client secret, HS256), and no encryption key. The issuer ends with a slash.
- **Authelia:** the client needs `access_token_signed_response_alg: RS256` for a JWT; scope comes
  as an array in `scp`; groups reach a JWT access token only through a claims policy.
- **Okta:** a custom authorization server (the org server's access tokens are opaque). The default
  `sub` of its access token can differ from the userinfo `sub`: set it to the user id.
- **Auth0:** a default audience on the tenant (without an API audience the access token is opaque),
  the API identifier in `NUXT_OIDC_AUDIENCE`, and the groups as a namespaced claim added by an Action.
- **Amazon Cognito:** `NUXT_OIDC_REQUIRED_SCOPE` is `<resource-server-id>/caldav`.
- **Microsoft Entra ID:** tenant-specific issuer, access token version 2, the scope of your own API in
  `NUXT_OIDC_SCOPE` (`api://<client-id>/caldav`, no `groups`). Userinfo does not take that token, so
  groups and the admin check do not work there yet.
- **Does not work:** Dex (its access token is an ID token and has no scope), providers whose access
  tokens are opaque (Google, per its [token types page](https://docs.cloud.google.com/docs/authentication/token-types),
  which gives no reason; GitHub; the Okta org server), and any that signs with a shared secret.
  `NUXT_OIDC_JWKS_HOSTS=www.googleapis.com` lets the keys of Google be fetched but does not change
  that: Google's access tokens cannot be verified here, and it has no custom scope for the required
  `caldav`. Supporting Google would need token introspection (`oauth2.googleapis.com/tokeninfo`) and
  a different scope rule, which are not built.
