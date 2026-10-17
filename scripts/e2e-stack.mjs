#!/usr/bin/env node
// Starts a FRESH OpenSend stack for the Playwright end-to-end test:
// new database, migrations, API (3101) and worker. Requires the docker-compose services.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pg = createRequire(path.join(root, 'packages/db/package.json'))('pg');
// Reuse local service credentials (MinIO etc.) from .env when present.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* no .env: defaults below */
}
const DB = 'opensend_e2e';
const admin =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://opensend:opensend@localhost:54329/postgres';
const dbUrl = admin.replace(/\/[^/]*$/, `/${DB}`);

const env = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  DATABASE_URL: dbUrl,
  REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://localhost:56379/14',
  API_PORT: '3101',
  WORKER_HEALTH_PORT: '3102',
  PUBLIC_WEB_URL: 'http://localhost:3100',
  PUBLIC_API_URL: 'http://localhost:3101',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  OPENSEND_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
  OPENSEND_ENCRYPTION_ACTIVE_KEY_ID: 'v1',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:59000',
  S3_BUCKET: 'opensend-e2e',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'opensend-local',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'opensend-local-secret',
  OPENSEND_LOCAL_PROVIDER_ENABLED: 'true',
  MAILPIT_SMTP_HOST: process.env.MAILPIT_SMTP_HOST ?? '127.0.0.1',
  MAILPIT_SMTP_PORT: process.env.MAILPIT_SMTP_PORT ?? '51025',
  MAILPIT_API_URL: process.env.MAILPIT_API_URL ?? 'http://localhost:58025',
};

const c = new pg.Client({ connectionString: admin });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${DB}`);
await c.end();

const run = (args, opts = {}) =>
  spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', ...opts });
await new Promise((resolve, reject) =>
  run(['packages/db/dist/migrate.js']).on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error('migration failed')),
  ),
);

// Expose env for the test (bootstrap-token CLI) through a file the spec reads.
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync(path.join(root, 'e2e', '.auth'), { recursive: true });
writeFileSync(path.join(root, 'e2e', '.auth', 'stack-env.json'), JSON.stringify(env), {
  mode: 0o600,
});

const api = run(['apps/api/dist/main.js']);
const worker = run(['apps/worker/dist/main.js']);
const stop = () => {
  api.kill('SIGTERM');
  worker.kill('SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
api.on('exit', (code) => process.exit(code ?? 1));
