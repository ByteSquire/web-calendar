# Spike test stack

Kanidm (OIDC provider) and Radicale (CalDAV store), run locally in Docker, for the spikes in
[docs/design.md](../../docs/design.md) §12. The app's server, which becomes the CalDAV gateway, is
developed separately and talks to both. This stack replaced an earlier one that also ran OpenCloud,
Traefik and oauth2-proxy; its findings are recorded under S1 in the design.

This is a throwaway test environment, separate from the app and its production image: self-signed
certificates, known ports, throwaway passwords.

## Requirements

- Docker with Compose.
- `openssl`, `curl` and `python3` on the host.
- Free ports `8443` (Kanidm) and `5232` (Radicale) on `127.0.0.1`.
- Internet access for the image pulls.

## Quick start

```sh
cd dev/spike-s1
./spike.sh up          # runs init first if needed
./spike.sh bootstrap   # Kanidm users, groups and OAuth2 clients
./spike.sh token alice
./spike.sh radicale alice PROPFIND /alice/ --depth 0
```

## What runs

| Service  | Image                                                    | URL                          | Role                                 |
| -------- | -------------------------------------------------------- | ---------------------------- | ------------------------------------ |
| kanidm   | `kanidm/server:latest` (1.11.2)                          | `https://idm.localhost:8443` | OIDC provider                        |
| radicale | `ghcr.io/kozea/radicale:3.9.0` (the project's own image) | `http://127.0.0.1:5232`      | CalDAV store, trusts `X-Remote-User` |

Radicale is configured as in the design ([radicale/config](radicale/config)):
`http_x_remote_user` authentication, a **static** owner-only rights file
([radicale/rights](radicale/rights), copied to `.local/rules/` by `init`), an `htgroup` group file
(`.local/rules/groups`) and sharing by map. It reads the config and the rights file only at startup;
the group file and shares take effect immediately. In production it has no published port and only
the app's gateway can reach it. Here it is published on the loopback interface so the app can be
developed against it, which means anything on this machine can claim to be any user.

The `*.localhost` names resolve to the loopback interface in browsers and curl. Containers resolve
`idm.localhost` through a network alias, so the issuer URL is the same inside and outside the stack.

## Accounts

Generated passwords are in `.local/secrets.env` (mode 600, git-ignored). The file is shell syntax: a
character such as `!` is written as `\!`, and the backslash is not part of the password. Do not copy a
value from the file by hand; read it with `sh -c '. .local/secrets.env && printf %s "$ALICE_PASSWORD"'`
(for example `... | wl-copy` to put it on the clipboard).

| What                 | Name           | Notes                                                                                                                                                   |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kanidm users         | `alice`, `bob` | Both in `web_calendar_users`; `alice` also in `calendar_admins`                                                                                         |
| Kanidm OAuth2 client | `web-calendar` | Public, PKCE. The SPA's login. Scopes `openid profile email groups caldav`; localhost redirects allowed, callback `http://localhost:3000/auth/callback` |
| Kanidm admin         | `idm_admin`    | Break-glass account, password recovered at bootstrap                                                                                                    |

## Commands

| Command                                        | Does                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `./spike.sh init`                              | Create test certificates and the `.local/rules` directory                  |
| `./spike.sh up`                                | Start the stack, wait for Kanidm                                           |
| `./spike.sh bootstrap`                         | Create users, groups, OAuth2 clients and passwords                         |
| `./spike.sh token alice`                       | Log in without a browser and print the SPA client's token response         |
| `./spike.sh radicale alice METHOD /path/ [..]` | Call Radicale directly, as the gateway will (sends `X-Remote-User: alice`) |
| `./spike.sh kanidm <args>`                     | Run the Kanidm CLI as `idm_admin`, for example `system oauth2 list`        |
| `./spike.sh logs [service]`, `status`, `down`  | Inspect and stop                                                           |
| `./spike.sh reset`                             | Delete containers, volumes and `.local/`                                   |

`radicale` accepts `--depth`, `--body`, `--content-type`, `--header "Name: value"` and `--limit`; see
[tools/spike_client.py](tools/spike_client.py). Example, create and query an event:

```sh
./spike.sh radicale alice PUT /alice/def-calendar/e1.ics \
  --content-type 'text/calendar; charset=utf-8' --header 'If-None-Match: *' --body "$(cat event.ics)"
./spike.sh radicale alice REPORT /alice/def-calendar/ --depth 1 --body "$(cat query.xml)"
```

## Which spike this serves

- **S4 (recurrence):** create a recurring event and try `calendar-query` with `expand` and a
  `time-range`.
- **S5 (access mechanics):** done, results below. Sharing example, as the owner `alice` (user ids are
  the Kanidm `sub` values; get them from `./spike.sh kanidm person get alice`):

  ```sh
  ./spike.sh radicale <alice-sub> POST /.sharing/v1/map/create --content-type application/json \
    --body '{"PathMapped":"/<alice-sub>/def-calendar/","PathOrToken":"/{user}/team/","User":":team","Permissions":"rw","Enabled":true,"Hidden":false}'
  echo 'team: <bob-sub>' > .local/rules/groups     # takes effect immediately
  ./spike.sh radicale <bob-sub> PROPFIND /<bob-sub>/ --depth 1   # lists /<bob-sub>/team/
  ```

- **S6 (gateway):** `token` gives the gateway realistic tokens (ES256 JWTs with the `caldav` scope)
  to verify locally against the client's published keys.

## Findings

### S5, Radicale access mechanics (2026-10-29)

Tested against Radicale 3.9.0 here; the design (§8) has the summary.

- The rights file is read once at startup; a new rule had no effect until a restart (`SIGHUP` stops the
  server). Keep it static.
- The `htgroup` file is re-read on every request: membership changes apply immediately.
- A rights rule with only `f` gives the metadata and `free-busy-query` (no titles); `calendar-query`
  and `GET` are denied.
- Sharing by map is live. A share to a group, with `PathOrToken` `/{user}/name/`, shows up in every
  member's home as a calendar, honors `r` and `rw`, and disappears when the member leaves the group. A
  share to a single user needs the owner to enable it and the user to accept and unhide it first.
- Untested: `f` as a share permission, real clients, behavior with many shares.

### S6, Kanidm tokens (2026-10-29)

- A custom scope such as `caldav` is accepted in a scope map and returned in tokens.
- Groups (scopes `groups`, `groups_name`, `groups_spn`) are in the ID token and the userinfo response,
  not in the access token.
- Introspection by a confidential client also worked for these tokens, but the design verifies JWTs
  locally instead, so the stack has no introspection client.
- A new service account cannot read groups (`GET /v1/group/<name>` returns `null`), also in
  `idm_service_desk`. In `idm_group_admins`, its read-only API token reads group members and cannot write
  (403). The app no longer needs such an account (groups come from the sign-in claim), so `bootstrap`
  does not create one any more; read a group with `./spike.sh kanidm group get <group>` (design §12, S9).

### S1, earlier stack with OpenCloud and oauth2-proxy (2026-10-29)

Measured on the earlier stack with OpenCloud and oauth2-proxy; the details are in the design (§12, S1):

- OpenCloud's `/caldav/` only accepts tokens from the one Kanidm client it is configured with, because
  Kanidm gives every client its own issuer and keys.
- Kanidm's introspection endpoint reports `active: true` for tokens of other clients when called by a
  confidential client.
- Kanidm sends `Access-Control-Allow-Origin: *` on its OAuth2 endpoints; Radicale needs its
  `[headers]` section for CORS if a browser app calls it from another origin.
- Access tokens are ES256 JWTs valid for 900 s and carry only `sub`; name, email and groups are in the
  ID token. The refresh grant works. Token exchange does not.

## Caveats

- Browsers do not trust the test CA, so `https://idm.localhost:8443` shows a certificate error until
  you trust `.local/certs/ca.crt` yourself (for example with mkcert for the real-browser spike). The
  scripts do not need a browser.
- The credential policy is relaxed so test users can log in with a password only (Kanidm requires
  MFA by default). Never copy this to a real instance.
- Kanidm cannot skip the consent prompt for a public client; the token helper approves the consent
  step itself.
- `kanidm/server` and `kanidm/tools` use `latest`. Override with `KANIDM_IMAGE` and
  `KANIDM_TOOLS_IMAGE` to pin them.
- `tests/integration/key-rotation.integration.test.ts` (`KEY_ROTATION_IT=1`, `NODE_EXTRA_CA_CERTS` set to
  `.local/certs/ca.crt`) rotates and revokes the signing keys of a throwaway OAuth2 client, `wcal-keytest`,
  on every run; the five `./spike.sh kanidm …` commands that create it are at the top of the test file.
  Never rotate `web-calendar`'s keys in a shared stack: it signs out every token.
