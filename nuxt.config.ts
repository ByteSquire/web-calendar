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
    },
    /** Key for hashing app tokens (HMAC-SHA256). */
    tokenHashKey: '',
    /** SQLite file for app-level data. */
    dbPath: '.data/web-calendar.db',
    radicale: {
      /** Internal URL of the CalDAV store; nothing else may reach it. */
      url: 'http://radicale:5232',
    },
    groupSync: {
      /** Read-only Kanidm API token of the group-sync service account. */
      token: '',
      intervalSec: '60',
    },
    gateway: {
      /** Comma-separated origins that may call /caldav/ from a browser (CORS); empty means none. */
      corsOrigins: '',
      /** Largest request body the gateway forwards, in bytes. */
      maxBodyBytes: '10485760',
    },
  },
  nitro: {
    // The numbered .sql files are read at startup through Nitro's storage, so they reach .output.
    serverAssets: [{ baseName: 'migrations', dir: './server/db/migrations' }],
  },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Web Calendar',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: 'Self-hosted web calendar that aggregates multiple calendars into one view.',
        },
      ],
    },
  },
})
