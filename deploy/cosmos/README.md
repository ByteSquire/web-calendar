# Cosmos ServApp

[`cosmos-compose.json`](cosmos-compose.json) installs Web Calendar as a
[Cosmos](https://cosmos-cloud.io/docs/cosmos-compose/) ServApp. It always installs the app. It can
also install its own Kanidm (sign-in) and Radicale (calendar store), or use the ones you already
run: the first two checkboxes of the install form decide. Every setting and every storage place
has a field in the form, with a description above it.

## 1. Push the image

Cosmos pulls images from a registry; it cannot build one, and a failed pull undoes the whole
install. Pushing a version tag publishes the image through Codeberg's CI
([README "Release image"](../../README.md#release-image)). To push one by hand instead, from the
repository root, with a new tag for every release:

```sh
docker build -t codeberg.org/bytesquire/web-calendar:0.1.0 .
docker login codeberg.org
docker push codeberg.org/bytesquire/web-calendar:0.1.0
```

Put the same name into the form's **App image** field. If the package is private, Cosmos pulls with
the login in its own Docker config file (`config.json` in `$DOCKER_CONFIG`, or in `~/.docker` of
the user Cosmos runs as; when Cosmos itself runs in a container, inside that container). Otherwise
make the package public.

## 2. Install

In Cosmos, open **ServApps**, choose **Import Compose File**, paste the contents of
`cosmos-compose.json` and fill in the form. Below the settings, choose the address of the app (and
of Kanidm, when it is installed too). After the install, Cosmos shows what is left to do.

What the template creates (`<name>` is the service name you choose):

| Container             | Optional | What it does                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `<name>`              | no       | The app and its CalDAV gateway (`/caldav/`). Reached only through its Cosmos route; no published port               |
| `<name>-radicale`     | yes      | Radicale, only on the internal network `<name>-radicale` that it shares with the app: no port, no route, no way out |
| `<name>-kanidm-certs` | yes      | Runs once, makes Kanidm's TLS certificate and stops. `Exited (0)` is its normal state                               |
| `<name>-kanidm`       | yes      | Kanidm, reached through its own Cosmos route                                                                        |

Storage, as Docker volumes, or as host folders with **Store data in host folders** (Cosmos creates
missing folders and gives the app's and Radicale's folders to uid 1000):

| Default volume / folder                      | Mounted at                        | Contents                                                    | Back up |
| -------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------- |
| `<name>-data` / `…/<name>/data`              | app `/data`                       | SQLite database (app tokens, access rules, bookings, audit) | yes     |
| `<name>-groups` / `…/<name>/groups`          | app `/groups`, Radicale read-only | Radicale's group file, rewritten by the group sync          | no      |
| `<name>-radicale-data` / `…/<name>/radicale` | Radicale `/var/lib/radicale`      | All calendars and `sharing.csv` (authorization state)       | yes     |
| `<name>-kanidm-data` / `…/<name>/kanidm`     | Kanidm `/data`                    | Kanidm database and its TLS certificate                     | yes     |

Back up the app database with [`scripts/backup-db.mjs`](../../scripts/backup-db.mjs), as the
[main README](../../README.md#production) shows, with `-v <name>-data:/data` (or the host folder) in
place of the Compose volume. Never copy the SQLite file while the app runs.

## Kanidm installed with the app

1. Get the admin password: `docker exec <name>-kanidm kanidmd recover-account idm_admin`.
2. Follow [`docs/kanidm-setup.md`](../../docs/kanidm-setup.md) with the server
   `https://<Kanidm address>`: the groups, the OAuth2 client with the redirect URL
   `https://<app address>/auth/callback`, and the group-sync account (it needs
   `idm_people_pii_read`).
3. Put the sync token into `NUXT_GROUP_SYNC_TOKEN` in the environment of the `<name>` container in
   Cosmos and save, so Cosmos recreates it. The token expires within 90 days; rotate it the same
   way.

Notes:

- The app fetches Kanidm's sign-in metadata from Kanidm's public address (the issuer URL). The
  containers must be able to resolve and reach that address; if sign-in fails while Kanidm works
  in a browser, check the DNS and hairpin NAT of the host.
- `kanidmd cert-generate` makes a self-signed certificate valid for 5 days. It is only used between
  Cosmos and Kanidm: the route accepts it without checking (as Kanidm requires TLS behind the
  proxy), and Kanidm does not check the date when it loads it, so the expiry breaks nothing. Users
  and the app see the certificate of Cosmos. To use your own, put `chain.pem` and `key.pem` into
  the Kanidm storage and restart `<name>-kanidm`.
- On the first start, Kanidm can start before its certificate exists. It then restarts until the
  certificate is there (a few seconds).
- Upgrade Kanidm one minor version at a time, in both Kanidm containers.

## Kanidm you already run

Untick **Install a Kanidm server** and enter the issuer URL of the app's client:
`https://<your Kanidm>/oauth2/openid/<client id>`. In Kanidm, the client needs the redirect URL
`https://<app address>/auth/callback`; the groups and the group-sync account are in
[`docs/kanidm-setup.md`](../../docs/kanidm-setup.md).

## Radicale you already run

Your Radicale trusts the `X-Remote-User` header, so anything that can reach it can act as any user.
Only the app may reach it: no published port, no Cosmos route, and a Docker network that only the
two share (best with `internal: true`). Enter that network in **Docker network of your Radicale**
and Radicale's address on it in **Radicale URL**.

Configure it like [`deploy/radicale/config`](../radicale/config) (tested with Radicale 3.9.0):

- `[auth] type = http_x_remote_user`
- `[rights]` from [`deploy/radicale/rights`](../radicale/rights), or `type = owner_only`, which the
  bundled Radicale uses (both gave the same answers to the same 279 requests)
- `[group] type = htgroup` with `htgroup_filename` pointing at `htgroup` in the app's group
  storage (the **Group file** field), mounted read-only into Radicale
- `[sharing] type = csv`, `collection_by_map = true`, `permit_create_map = true`, with the
  database in Radicale's data storage
- `[storage] predefined_collections` as in the file, for each user's first calendar
- `[server] max_content_length` the same as the app's **Largest CalDAV request**
- `[web] type = none`

Radicale refuses to start without the group file. The app creates an empty one when it starts, so
start Radicale after the app.

## Differences from `docker-compose.yml`

- Cosmos has no `read_only` or `tmpfs`, so the containers' own file systems are writable here. The
  rest of the hardening stays: all capabilities dropped, `no-new-privileges`, uid 1000 for the app
  and Radicale, Radicale on an internal network with no port or route.
- Cosmos starts the containers in order, one second apart, without waiting for "healthy". The app
  writes the empty group file at once, so Radicale finds it. Right after the first start the app
  can log one `[sharing] reconcile failed (unreachable)` line, because Radicale starts after it; it
  retries with backoff.
- The health check runs every 30 s from the start, so the app shows as healthy after about 30 s.
- The Cosmos proxy sets `X-Forwarded-For`, so **Trust X-Forwarded-For** is on by default. Keep it on
  only while the app is reachable through Cosmos alone.

## How it was checked (2026-11-02)

Against the source of Cosmos 0.23.4 and its template validator. All 24 combinations of the form's
choices (Kanidm, Radicale, host folders, outbound hosts) render to valid JSON with the expected
services, settings, storage and networks. The full stack (app, Radicale, Kanidm) started with
volumes and with host folders when created and started the way Cosmos does it, and the isolation
of Radicale held. It has not been installed in a running Cosmos yet.
