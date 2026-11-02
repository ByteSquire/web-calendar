# Reverse proxy (security review 2026-11-01, finding 4)

The app binds to `127.0.0.1:3000` only (`docker-compose.yml`) and expects a reverse proxy in
front for TLS. Nothing here is required reading to run the app; it exists because
`docs/security-review.md` §7.8 asks for it and no example existed.

Both examples below do the same four things:

1. **TLS**, and HSTS once it is in place (the app sends no HSTS header itself; see
   `docs/design.md` §6 — that is a deliberate choice, left to the proxy).
2. **Append**, never set, `X-Forwarded-For`, and set `NUXT_GATEWAY_TRUST_FORWARDED_FOR=true` only
   when this proxy is the one way to reach the app. Set wrongly, a client can name any address and
   escape the login throttle (`docs/security-review.md` §2, "Throttles behind a reverse proxy").
3. **A body size limit** at least as large as `NUXT_GATEWAY_MAX_BODY_BYTES` (10 MiB by default), so
   a large CalDAV `PUT` reaches the app's own limit instead of being cut off earlier with a
   confusing error.
4. **No buffering of the request body** for `/caldav/`: Radicale and the gateway stream it; a
   proxy that buffers the whole body first adds latency and a memory cost for no benefit.

## nginx

```nginx
server {
  listen 443 ssl;
  server_name calendar.example.org;

  ssl_certificate     /etc/letsencrypt/live/calendar.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/calendar.example.org/privkey.pem;
  add_header Strict-Transport-Security "max-age=63072000" always;

  client_max_body_size 10m; # matches NUXT_GATEWAY_MAX_BODY_BYTES

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # appends, never overwrites
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /caldav/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1; # older nginx buffers a chunked body over HTTP/1.0 despite the next line
    proxy_request_buffering off;
  }
}
```

## Caddy

```caddyfile
calendar.example.org {
  header Strict-Transport-Security "max-age=63072000"
  request_body {
    max_size 10MiB # matches NUXT_GATEWAY_MAX_BODY_BYTES (10 MiB; Caddy's 10MB is 10,000,000 bytes)
  }
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1 # do not buffer responses; Caddy streams request bodies by default
  }
}
```

Caddy writes `X-Forwarded-For` itself: it drops what the client sent and sets the client's address,
unless the client is listed in `trusted_proxies`, in which case it appends. Either way the last
entry is the address Caddy saw, which is what the app reads. Do not add a `header_up
X-Forwarded-For` line: built from placeholders it yields `,<address>` when the client sent none.
Set `NUXT_GATEWAY_TRUST_FORWARDED_FOR=true` only once this proxy is genuinely the sole path to the
app.

## Tested

2026-11-02, nginx 1.31.8 (`nginx:alpine`) and Caddy 2.11.7 (`caddy:2-alpine`) as throwaway
containers with a self-signed certificate (Caddy: `tls internal`), the examples above unchanged
except the upstream address and certificate paths, in front of the production image from
`docker-compose.yml`: `nginx -t` and `caddy validate` pass; HSTS is sent; nginx appends to a
client's `X-Forwarded-For` (`203.0.113.9, <client>`) and Caddy replaces it (`<client>`); a 10 MiB
`PUT` passes and 10 MiB + 1 byte gets `413` from both; a chunked `PUT` sent over 3 s reaches the
upstream as it is sent, not after; `PROPFIND /.well-known/caldav` gives `301` to `/caldav/` and
`PROPFIND /caldav/` without or with wrong credentials gives `401` from the gateway. Not tested: an
authenticated `PROPFIND` (no Kanidm in the run), the throttle with
`NUXT_GATEWAY_TRUST_FORWARDED_FOR=true`, Let's Encrypt and a proxy on another host.
