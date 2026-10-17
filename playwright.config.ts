import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end test of a fresh local installation. Requires the docker-compose services
 * (postgres, redis, minio, mailpit) and built packages (`pnpm build`).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
  },
  webServer: [
    {
      command: 'node scripts/e2e-stack.mjs',
      url: 'http://localhost:3101/health/ready',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: 'pnpm --filter @opensend/web exec next dev --port 3100',
      url: 'http://localhost:3100/login',
      reuseExistingServer: false,
      timeout: 180_000,
      env: { OPENSEND_API_INTERNAL_URL: 'http://localhost:3101', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
