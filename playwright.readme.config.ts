import { defineConfig } from '@playwright/test';

/**
 * Regenerates the README screenshots from a fresh local stack with fictional sample data.
 *   pnpm build && pnpm readme:screenshots
 * Requires the docker-compose services. Images land in docs/readme/.
 */
export default defineConfig({
  testDir: './scripts/readme',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  webServer: [
    {
      command: 'node scripts/e2e-stack.mjs',
      url: 'http://localhost:3101/health/ready',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        E2E_DB_NAME: 'opensend_readme',
        E2E_PRIVATE_NETWORK_ALLOWLIST: 'localhost',
        E2E_WEBHOOK_ALLOW_HTTP: 'true',
      },
    },
    {
      command: 'pnpm --filter @opensend/web exec next dev --port 3100',
      url: 'http://localhost:3100/login',
      timeout: 180_000,
      reuseExistingServer: false,
      env: { OPENSEND_API_INTERNAL_URL: 'http://localhost:3101', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
