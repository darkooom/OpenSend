#!/usr/bin/env node
// Creates .env from .env.example with freshly generated local secrets (never overwrites).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const target = path.join(root, '.env');
if (existsSync(target)) {
  console.log('.env already exists – leaving it untouched.');
  process.exit(0);
}
let env = readFileSync(path.join(root, '.env.example'), 'utf8');
const set = (key, value) => {
  env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
};
set('BETTER_AUTH_SECRET', randomBytes(32).toString('base64url'));
set('OPENSEND_ENCRYPTION_KEYS', `v1:${randomBytes(32).toString('base64')}`);
set('S3_SECRET_ACCESS_KEY', randomBytes(24).toString('base64url'));
set('OPENSEND_WEBHOOK_ALLOW_HTTP', 'true');
writeFileSync(target, env, { mode: 0o600 });
console.log('Wrote .env with random local secrets (mode 600).');
console.log('Next: pnpm services:up && pnpm db:migrate && pnpm bootstrap:token');
