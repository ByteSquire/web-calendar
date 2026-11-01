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
    proxy_request_buffering off;
  }
}
```

## Caddy

```caddyfile
calendar.example.org {
  header Strict-Transport-Security "max-age=63072000"
  request_body {
    max_size 10MB # matches NUXT_GATEWAY_MAX_BODY_BYTES
  }
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-For {http.request.header.X-Forwarded-For},{http.request.remote.host}
    flush_interval -1 # do not buffer; matters for /caldav/
  }
}
```

Caddy appends to `X-Forwarded-For` itself when the header is left out of `header_up`; the line
above is only needed if another proxy ahead of Caddy already sets the header and both should be
kept. Either way, set `NUXT_GATEWAY_TRUST_FORWARDED_FOR=true` only once this proxy is genuinely the
sole path to the app.
