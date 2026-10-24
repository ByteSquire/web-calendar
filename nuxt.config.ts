// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  runtimeConfig: {
    oidc: {
      issuer: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    },
    caldav: {
      baseUrl: '',
    },
    sync: {
      intervalMin: '5',
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
        {
          name: 'description',
          content: 'Self-hosted web calendar that aggregates multiple calendars into one view.',
        },
      ],
    },
  },
})
