import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite. Runs against a production build (`next start`) backed by
 * a fresh Postgres database, so what passes here is what ships.
 *
 *   npm run e2e            # prepares the DB, builds, starts, tests
 *
 * The app server's environment comes from the e2e script; see package.json.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
// localhost, not 127.0.0.1: self-hosted `next start` reports its host to
// middleware as localhost, so redirects and Origin checks line up with it.
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const executablePath = process.env.CHROMIUM_PATH ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-report.json' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    // Signs in the synthetic preview tester the form tests run as.
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: `npx next start -p ${PORT} -H localhost`,
          url: `${BASE_URL}/`,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,
        },
      }),
});
