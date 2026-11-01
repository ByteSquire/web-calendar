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
      /** Issuer of the app's own Kanidm client, e.g. https://idm.example.org/oauth2/openid/web-calendar */
      issuer: '',
      /** The app's own public client; the SPA logs in with it. */
      clientId: 'web-calendar',
      /** Comma-separated client ids whose JWTs the gateway accepts; empty means `clientId` only. */
      allowedClients: '',
      /** Scopes the SPA requests. */
      scope: 'openid profile email groups_name caldav',
      /** Scope every accepted access token must carry. */
      requiredScope: 'caldav',
      /** Kanidm group whose members are admins (checked on /api/me and, later, admin routes). */
      adminGroup: 'calendar_admins',
      /**
       * Seconds the cached Kanidm signing keys are used before they are fetched again in the
       * background (NUXT_OIDC_KEY_MAX_AGE_SEC). A key Kanidm removed stops being trusted then.
       */
      keyMaxAgeSec: '3600',
    },
    /**
     * Demo mode (NUXT_DEMO=true): the SPA skips the login and shows the built-in mock data. For
     * previews and the browser tests of the layout. The API still requires a token.
     */
    demo: false,
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
    groupSync: {
      /** Read-only Kanidm API token of the group-sync service account. */
      token: '',
      /** Seconds between runs (NUXT_GROUP_SYNC_INTERVAL_SEC); at most 300, larger values are clamped. */
      intervalSec: '60',
      /**
       * Radicale's group file (NUXT_GROUP_SYNC_FILE). Empty means /groups/htgroup in production and
       * .data/htgroup in development.
       */
      file: '',
    },
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
       * (NUXT_OUTBOUND_ALLOWED_HOSTS). Empty means every public host. A listed host may live in a
       * private range; loopback, link-local and the CalDAV store's host never. The server refuses
       * to start with a malformed list.
       */
      allowedHosts: '',
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
