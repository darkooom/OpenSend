import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * API keys look like `os_<prefix>_<secret>`. The prefix (12 chars, public) locates the row,
 * the secret (32 random bytes) is only stored as SHA-256. High entropy makes a slow hash unnecessary.
 */
export interface GeneratedApiKey {
  key: string;
  prefix: string;
  secretHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
  const secret = randomToken(32);
  return { key: `os_${prefix}_${secret}`, prefix, secretHash: sha256Hex(secret) };
}

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const m = /^os_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{40,64})$/.exec(raw.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

/** Stable JSON (sorted keys) for request hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashRequest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
