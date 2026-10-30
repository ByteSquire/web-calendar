import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Real-login browser tests (design S8): the production build with the login switched ON, against
// the test stack's Kanidm and Radicale (dev/spike-s1, reachable from the Dev Container). Run with
// `npm run test:e2e:live` after `nuxt build`. The browser must reach `idm.localhost`, which
// Chromium would send to loopback: it is mapped to the address the container resolves. The page is
// served from http://localhost (Kanidm allows `localhost` redirect URLs for the test client).
const PORT = 3400
const CA = resolve('dev/spike-s1/.local/certs/ca.crt')
const kanidmAddress = execFileSync('getent', ['hosts', 'idm.localhost'], { encoding: 'utf8' })
  .trim()
  .split(/\s+/)[0]

export default defineConfig({
  testDir: 'e2e/live',
  outputDir: 'test-results-live',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'live-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: { args: [`--host-resolver-rules=MAP idm.localhost ${kanidmAddress}`] },
      },
    },
  ],
  webServer: {
    command: 'node .output/server/index.mjs',
    url: `http://localhost:${PORT}/api/config`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
      NUXT_DB_PATH: '/tmp/e2e-live.db',
      NUXT_OIDC_ISSUER: 'https://idm.localhost:8443/oauth2/openid/web-calendar',
      NUXT_RADICALE_URL: 'http://radicale:5232',
      NUXT_TOKEN_HASH_KEY: 'e2e-live-key-e2e-live-key-e2e-live-key',
      NODE_EXTRA_CA_CERTS: CA,
    },
  },
})
