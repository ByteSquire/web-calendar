import { defineConfig, devices } from '@playwright/test'

// Browser tests of the built app (`npm run test:e2e` builds it first). The projects are the
// responsive matrix of design §13 Step 9: both phone orientations, a tablet and a desktop in the
// light scheme, plus a phone and a desktop in the dark one and a WebKit phone.
const PORT = 3100

const phone = { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true }

export default defineConfig({
  testDir: 'e2e',
  // The real-login tests have their own config (playwright.live.config.ts).
  testIgnore: '**/live/**',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], ...phone } },
    {
      name: 'phone-landscape',
      use: { ...devices['Pixel 7'], ...phone, viewport: { width: 640, height: 360 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Pixel 7'], ...phone, viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'phone-dark', use: { ...devices['Pixel 7'], ...phone, colorScheme: 'dark' } },
    {
      name: 'desktop-dark',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        colorScheme: 'dark',
      },
    },
    { name: 'webkit-phone', use: { ...devices['iPhone SE'] } },
  ],
  webServer: {
    command: 'node .output/server/index.mjs',
    url: `http://127.0.0.1:${PORT}/api/config`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
      NUXT_DEMO: 'true',
      // The build runs in production, which refuses an empty host list unless this is true; the
      // browser tests keep what an empty list always meant (security review 2026-11-01).
      NUXT_OUTBOUND_ALLOW_ANY_HOST: 'true',
      NUXT_DB_PATH: '.data/e2e.db',
      NUXT_OIDC_ISSUER: 'https://idm.example.org/oauth2/openid/web-calendar',
      NUXT_TOKEN_HASH_KEY: 'e2e-test-key-e2e-test-key-e2e-test-key',
    },
  },
})
