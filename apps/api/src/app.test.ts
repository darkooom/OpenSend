import { describe, expect, it } from 'vitest';
import { sanitizeRequestUrl } from './app';

describe('sanitizeRequestUrl', () => {
  it('drops query credentials from access logs', () => {
    expect(sanitizeRequestUrl('/api/invitations/lookup?token=secret')).toBe(
      '/api/invitations/lookup',
    );
  });

  it('collapses authentication callback paths that may contain credentials', () => {
    expect(sanitizeRequestUrl('/api/auth/reset-password/secret?callback=x')).toBe(
      '/api/auth/[redacted]',
    );
  });
});
