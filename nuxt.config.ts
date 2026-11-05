// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/eslint', '@nuxt/ui'],
  devtools: { enabled: true },
  // The logged-in app is a SPA; Nitro serves the API and the CalDAV gateway (design §1, §4).
  ssr: false,
  // Server-only values. Each maps to an environment variable: `oidc.allowedClients` is
  // NUXT_OIDC_ALLOWED_CLIENTS, `radicale.url` is NUXT_RADICALE_URL, `tokenHashKey` is
  // NUXT_TOKEN_HASH_KEY (design §10). The SPA gets the public OIDC values from `/api/config`.
  runtimeConfig: {
    oidc: {
      /**
       * Issuer of the identity provider, exactly as its discovery document writes it (a trailing
       * slash included). Kanidm: https://idm.example.org/oauth2/openid/web-calendar (one issuer per
       * client); Keycloak: https://keycloak.example.org/realms/<realm>.
       */
      issuer: '',
      /** The app's own public client; the SPA logs in with it. */
      clientId: 'web-calendar',
      /** Comma-separated client ids whose JWTs the gateway accepts; empty means `clientId` only. */
      allowedClients: '',
      /**
       * Further `aud` values that make an access token ours, comma-separated (NUXT_OIDC_AUDIENCE):
       * the API identifier of Auth0 or Entra, whose tokens are issued for the API and not the client.
       */
      audience: '',
      /**
       * Host names besides the issuer's own that the signing keys may be fetched from, comma-separated
       * (NUXT_OIDC_JWKS_HOSTS). Empty means the issuer's host only. Exact names, no wildcards.
       */
      jwksHosts: '',
      /** Scopes the SPA requests. */
      scope: 'openid profile email groups caldav',
      /**
       * Scope every accepted access token must carry, in `scope` or `scp`. It also keeps ID tokens
       * out: they carry none.
       */
      requiredScope: 'caldav',
      /**
       * Group whose members are admins (checked on /api/me and the admin routes): its name, its
       * SPN, its id or its path, whatever the provider puts in the groups claim.
       */
      adminGroup: 'calendar_admins',
      /**
       * Name of the claim that lists the person's groups (NUXT_OIDC_GROUPS_CLAIM), in userinfo and in
       * the access token. Looked up as written, so `cognito:groups` or a URL works.
       */
      groupsClaim: 'groups',
      /**
       * Groups that are never offered for import, comma-separated names or `prefix*`
       * (NUXT_OIDC_GROUPS_IGNORE). The default hides Kanidm's built-in groups.
       *
       * WARNING: a group that is imported already and matches a new entry here is no longer
       * imported. Its members are taken out of it at their next sign-in, so nobody reaches its
       * calendars through it any more (the group, its calendars and rules stay until an admin
       * stops importing it). The people themselves stay registered and keep their other groups.
       */
      groupsIgnore: 'idm_*,system_*,domain_*',
      /**
       * Seconds the cached signing keys are used before they are fetched again in the background
       * (NUXT_OIDC_KEY_MAX_AGE_SEC). A key the provider removed stops being trusted then.
       */
      keyMaxAgeSec: '3600',
    },
    /**
     * Demo mode (NUXT_DEMO=true): the SPA skips the login and shows the built-in mock data. For
     * previews and the browser tests of the layout. The API still requires a token.
     */
    demo: false,
    /**
     * Days a person counts as active after their last sign-in (NUXT_SIGNIN_WINDOW_DAYS, 1 to 365).
     * It bounds the app tokens (a token stops working when its owner has not signed in to the web
     * app within it) and the group of everyone (`web_calendar_users`). Imported and app groups are
     * not bounded by it.
     */
    signinWindowDays: '30',
    /** Key for hashing app tokens (HMAC-SHA256); key version 1. */
    tokenHashKey: '',
    /**
     * More keys, `version:key` separated by commas, the current one first (NUXT_TOKEN_HASH_KEYS);
     * empty means `tokenHashKey` only. How to rotate the key: server/utils/auth/token-keys.ts.
     */
    tokenHashKeys: '',
    /** SQLite file for app-level data. */
    dbPath: '.data/web-calendar.db',
    radicale: {
      /** Internal URL of the CalDAV store; nothing else may reach it. */
      url: 'http://radicale:5232',
    },
    /**
     * Radicale's group file (NUXT_GROUPS_FILE), which the app writes from its database. Empty means
     * /groups/htgroup in production and .data/htgroup in development.
     */
    groupsFile: '',
    sharing: {
      /** Seconds between sharing reconciles (NUXT_SHARING_RECONCILE_INTERVAL_SEC); at most 900. */
      reconcileIntervalSec: '300',
      /** Hours between the consistency audits of every home (NUXT_SHARING_AUDIT_INTERVAL_HOURS). */
      auditIntervalHours: '24',
      /**
       * Service principals whose calendars are mirrored as shared calendars, comma-separated, for
       * example `_team` (NUXT_SHARING_SHARED_OWNERS). `_resources` is handled by the app itself.
       */
      sharedOwners: '',
    },
    resources: {
      /** Seconds between booking reconciles (NUXT_RESOURCES_RECONCILE_INTERVAL_SEC); at most 900. */
      reconcileIntervalSec: '300',
      /** 'false' stops a manager of a resource cancelling bookings of others (NUXT_RESOURCES_MANAGER_CANCEL). */
      managerCancel: 'true',
    },
    /** The iCal proxy that fetches .ics subscriptions for the browser (design §4, FR-7). */
    icalProxy: {
      /** Seconds a fetched file is served without asking the source again. */
      cacheTtlSec: '300',
      /** Largest file the proxy accepts, in bytes. */
      maxBytes: '5242880',
      /** Milliseconds to wait for the source. */
      timeoutMs: '10000',
      /**
       * 'true' lets subscriptions point at private addresses; for tests only (SSRF guard). The
       * server refuses to start with it when NODE_ENV=production.
       */
      allowPrivate: 'false',
    },
    /** Outbound requests of the server for its users: iCal subscriptions and external accounts. */
    outbound: {
      /**
       * Comma-separated host names the server may contact for its users, case-insensitive: exact
       * (`cal.example.org`) or below a domain (`*.example.org`, not `example.org` itself)
       * (NUXT_OUTBOUND_ALLOWED_HOSTS). Empty means every public host, which in production needs
       * `allowAnyHost` as well (below). A listed host may live in a private range; loopback,
       * link-local and the CalDAV store's host never. The server refuses to start with a
       * malformed list.
       */
      allowedHosts: '',
      /**
       * NUXT_OUTBOUND_ALLOW_ANY_HOST: with no list, production starts only when this is `true`
       * (security review 2026-11-01, finding 1). An open list is a channel to a host chosen by
       * whoever can sign in, or by a script injected into the page: it must be a decision, not a
       * default. Ignored when a list is set, and outside production.
       */
      allowAnyHost: 'false',
    },
    /** External CalDAV accounts (FR-8). */
    external: {
      /**
       * Key that seals the passwords of accounts with a login (NUXT_EXTERNAL_SEAL_KEY): 32 random
       * bytes, base64 or 64 hex characters (`openssl rand -base64 32`). Empty means accounts with a
       * login are off. Changing it voids every seal: users enter their passwords again.
       */
      sealKey: '',
    },
    gateway: {
      /** Comma-separated origins that may call /caldav/ from a browser (CORS); empty means none. */
      corsOrigins: '',
      /** Largest request body the gateway forwards, in bytes. */
      maxBodyBytes: '10485760',
      /**
       * Requests one signed-in user may have in flight at once (NUXT_GATEWAY_MAX_CONCURRENT_PER_USER);
       * the next ones get 429 until one finishes (security review 2026-11-01, finding 9).
       */
      maxConcurrentPerUser: '8',
      /**
       * 'true' takes the client address from the last entry of X-Forwarded-For instead of the socket
       * (NUXT_GATEWAY_TRUST_FORWARDED_FOR), for the throttle of failed Basic logins. Only behind a
       * reverse proxy that is the sole way to reach the app and overwrites that header; otherwise a
       * client can name any address. Off, every client behind a proxy shares the proxy's address:
       * correct logins still work, but strangers' failures share one budget.
       */
      trustForwardedFor: 'false',
    },
  },
  nitro: {
    // The numbered .sql files are read at startup through Nitro's storage, so they reach .output.
    serverAssets: [{ baseName: 'migrations', dir: './server/db/migrations' }],
  },
  // Icons come from this app (the bundled @iconify-json/lucide collection, served at
  // /api/_nuxt_icon), never from api.iconify.design: Nuxt Icon's default for `ssr: false` is that
  // public API, which would send every user's browser to a third party and break a strict CSP.
  icon: {
    provider: 'server',
    fallbackToApi: false,
    serverBundle: 'local',
    // `scan` finds the icons written in templates; these are chosen at runtime in .ts files
    // (app/utils/calendar-icons.ts and the status icons there), so they are named here.
    clientBundle: {
      scan: true,
      icons: [
        'lucide:calendar',
        'lucide:users',
        'lucide:layers',
        'lucide:shield',
        'lucide:star',
        'lucide:door-open',
        'lucide:car',
        'lucide:wrench',
        'lucide:triangle-alert',
      ],
    },
  },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Web Calendar',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        // The page handles both schemes itself (assets/css/main.css): no forced dark mode on top.
        { name: 'color-scheme', content: 'light dark' },
        {
          name: 'description',
          content: 'Self-hosted web calendar that aggregates multiple calendars into one view.',
        },
      ],
    },
  },
})
