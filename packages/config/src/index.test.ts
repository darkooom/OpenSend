import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './index';

const base = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  BETTER_AUTH_SECRET: 'a'.repeat(40),
  OPENSEND_ENCRYPTION_KEYS: 'v1:' + Buffer.alloc(32, 7).toString('base64'),
  OPENSEND_ENCRYPTION_ACTIVE_KEY_ID: 'v1',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's'.repeat(20),
};

describe('parseConfig', () => {
  it('accepts a minimal development configuration', () => {
    const c = parseConfig(base);
    expect(c.API_PORT).toBe(3001);
    expect(c.OPENSEND_LOCAL_PROVIDER_ENABLED).toBe(false);
  });

  it('refuses placeholder secrets in production', () => {
    expect(() =>
      parseConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_WEB_URL: 'https://app.example.org',
        PUBLIC_API_URL: 'https://api.example.org',
        OPENSEND_METRICS_TOKEN: 'metrics-secret',
        BETTER_AUTH_SECRET: 'opensend-dev-secret-do-not-use-in-production',
      }),
    ).toThrow(ConfigError);
  });

  it('refuses the local provider in production', () => {
    expect(() =>
      parseConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_WEB_URL: 'https://app.example.org',
        PUBLIC_API_URL: 'https://api.example.org',
        OPENSEND_METRICS_TOKEN: 'metrics-secret',
        OPENSEND_LOCAL_PROVIDER_ENABLED: 'true',
      }),
    ).toThrow(/LOCAL_PROVIDER/);
  });

  it('accepts a hardened production configuration', () => {
    expect(() =>
      parseConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_WEB_URL: 'https://app.example.org',
        PUBLIC_API_URL: 'https://api.example.org',
        OPENSEND_METRICS_TOKEN: 'metrics-secret',
      }),
    ).not.toThrow();
  });

  it('refuses a plaintext public API URL in production', () => {
    expect(() =>
      parseConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_WEB_URL: 'https://app.example.org',
        PUBLIC_API_URL: 'http://api.example.org',
        OPENSEND_METRICS_TOKEN: 'metrics-secret',
      }),
    ).toThrow(/PUBLIC_API_URL must use https/);
  });

  it('requires a metrics token in production', () => {
    expect(() =>
      parseConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_WEB_URL: 'https://app.example.org',
        PUBLIC_API_URL: 'https://api.example.org',
      }),
    ).toThrow(/OPENSEND_METRICS_TOKEN/);
  });
});
