import { z } from 'zod';

/**
 * Central, validated runtime configuration shared by API and worker.
 * Every value comes from the process environment; nothing here phones home.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number, min = 0) =>
  z.coerce
    .number()
    .int()
    .min(min)
    .optional()
    .transform((v) => v ?? def);

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: int(3001, 1),
  /** Origin of the dashboard. Session cookies and CSRF origin checks are bound to it. */
  PUBLIC_WEB_URL: z.url().default('http://localhost:3000'),
  /** Public base URL of the HTTP API (used in docs, OpenAPI servers and webhook test links). */
  PUBLIC_API_URL: z.url().default('http://localhost:3001'),
  TRUST_PROXY: bool(false),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),

  /** Comma separated list of `keyId:base64(32 bytes)`. Lives outside the database. */
  OPENSEND_ENCRYPTION_KEYS: z.string().min(1),
  OPENSEND_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool(true),

  /** Enables the "local development" provider which delivers to the operator-configured Mailpit. */
  OPENSEND_LOCAL_PROVIDER_ENABLED: bool(false),
  MAILPIT_SMTP_HOST: z.string().default('localhost'),
  MAILPIT_SMTP_PORT: int(1025, 1),
  MAILPIT_API_URL: z.string().default('http://localhost:8025'),

  /**
   * Operator-only allowlist of hostnames that may resolve to private addresses
   * (e.g. an internal relay). Never settable through a tenant API.
   */
  OPENSEND_PRIVATE_NETWORK_ALLOWLIST: csv,
  /** Allow plain http:// webhook targets. Only meant for local development. */
  OPENSEND_WEBHOOK_ALLOW_HTTP: bool(false),

  OPENSEND_MAX_RECIPIENTS: int(50, 1),
  OPENSEND_MAX_SUBJECT_LENGTH: int(998, 1),
  OPENSEND_MAX_BODY_BYTES: int(2 * 1024 * 1024, 1),
  OPENSEND_MAX_ATTACHMENTS: int(10, 0),
  OPENSEND_MAX_ATTACHMENT_BYTES: int(10 * 1024 * 1024, 0),
  OPENSEND_MAX_REQUEST_BYTES: int(20 * 1024 * 1024, 1024),
  OPENSEND_MAX_SCHEDULE_DAYS: int(30, 1),
  OPENSEND_MAX_BATCH_SIZE: int(100, 1),
  OPENSEND_MAX_PENDING_PER_ENVIRONMENT: int(10000, 1),
  OPENSEND_DEFAULT_MONTHLY_QUOTA: int(10000, 0),
  OPENSEND_RATE_LIMIT_PER_MINUTE: int(600, 1),

  OPENSEND_IDEMPOTENCY_TTL_HOURS: int(24, 1),
  OPENSEND_MAX_SEND_ATTEMPTS: int(5, 1),
  OPENSEND_SEND_LEASE_SECONDS: int(120, 10),
  OPENSEND_PROVIDER_TIMEOUT_MS: int(30000, 1000),
  OPENSEND_WEBHOOK_TIMEOUT_MS: int(10000, 500),
  OPENSEND_MAX_WEBHOOK_ATTEMPTS: int(8, 1),
  OPENSEND_INVITATION_TTL_HOURS: int(72, 1),

  /** Bearer token required for GET /metrics. Leave empty only if /metrics is not publicly reachable. */
  OPENSEND_METRICS_TOKEN: z.string().optional(),

  /** Server-wide allowlist of SNS topic ARNs accepted for SES event ingestion (in addition to per-connection config). */
  OPENSEND_SES_ALLOWED_TOPIC_ARNS: csv,
});

export type AppConfig = z.infer<typeof configSchema>;

/** Values that appear in `.env.example`; production must never run with them. */
export const KNOWN_PLACEHOLDER_SECRETS = [
  'change-me',
  'changeme',
  'replace-me',
  'opensend-dev-secret-do-not-use-in-production',
  'minioadmin',
];

export class ConfigError extends Error {}

export function parseConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  assertProductionSafety(config);
  return config;
}

export function assertProductionSafety(config: AppConfig): void {
  if (config.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  const secrets: Array<[string, string]> = [
    ['BETTER_AUTH_SECRET', config.BETTER_AUTH_SECRET],
    ['S3_SECRET_ACCESS_KEY', config.S3_SECRET_ACCESS_KEY],
    ['OPENSEND_ENCRYPTION_KEYS', config.OPENSEND_ENCRYPTION_KEYS],
  ];
  for (const [name, value] of secrets) {
    const lower = value.toLowerCase();
    if (KNOWN_PLACEHOLDER_SECRETS.some((p) => lower.includes(p))) {
      problems.push(`${name} contains a known placeholder value`);
    }
  }
  if (config.OPENSEND_LOCAL_PROVIDER_ENABLED) {
    problems.push('OPENSEND_LOCAL_PROVIDER_ENABLED must be false in production');
  }
  if (config.OPENSEND_WEBHOOK_ALLOW_HTTP) {
    problems.push('OPENSEND_WEBHOOK_ALLOW_HTTP must be false in production');
  }
  if (!config.PUBLIC_WEB_URL.startsWith('https://')) {
    problems.push('PUBLIC_WEB_URL must use https:// in production');
  }
  if (problems.length > 0) {
    throw new ConfigError(`Refusing to start in production: ${problems.join('; ')}`);
  }
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  cached ??= parseConfig();
  return cached;
}
/** Test helper: reset memoized configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}
