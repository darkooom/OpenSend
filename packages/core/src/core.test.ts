import { describe, expect, it } from 'vitest';
import { KeyRing } from './crypto';
import { canonicalJson, generateApiKey, parseApiKey, sha256Hex } from './tokens';
import { backoffDelayMs } from './backoff';
import { redact } from './redact';
import { isLocalOnlyDomain, normalizeDomain } from './domain-name';
import { renderTemplate, resolveValues, TemplateError, validateTemplateSource } from './render';
import {
  generateWebhookSecret,
  signatureHeader,
  verifyWebhook,
  WebhookVerificationError,
} from './webhook-signature';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

describe('KeyRing', () => {
  it('round-trips and binds ciphertext to its context', () => {
    const ring = new KeyRing({ v1: k1 }, 'v1');
    const c = ring.encrypt('secret', 'conn:1');
    expect(c.startsWith('osenc1.v1.')).toBe(true);
    expect(ring.decrypt(c, 'conn:1')).toBe('secret');
    expect(() => ring.decrypt(c, 'conn:2')).toThrow();
  });

  it('detects tampering', () => {
    const ring = new KeyRing({ v1: k1 }, 'v1');
    const parts = ring.encrypt('secret', 'a').split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => ring.decrypt(parts.join('.'), 'a')).toThrow();
  });

  it('decrypts old key versions after rotation', () => {
    const old = new KeyRing({ v1: k1 }, 'v1');
    const c = old.encrypt('x', 'a');
    const rotated = new KeyRing({ v1: k1, v2: k2 }, 'v2');
    expect(rotated.decrypt(c, 'a')).toBe('x');
    expect(rotated.needsRotation(c)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('x', 'a'))).toBe(false);
  });

  it('parses keys from env format', () => {
    const ring = KeyRing.fromEnv(`v1:${k1.toString('base64')}, v2:${k2.toString('base64')}`, 'v2');
    expect(ring.activeKeyId).toBe('v2');
    expect(() => KeyRing.fromEnv(`v1:${Buffer.alloc(16).toString('base64')}`, 'v1')).toThrow();
  });
});

describe('api keys', () => {
  it('generates parseable keys and stores only a hash', () => {
    const k = generateApiKey();
    const parsed = parseApiKey(k.key);
    expect(parsed?.prefix).toBe(k.prefix);
    expect(sha256Hex(parsed!.secret)).toBe(k.secretHash);
    expect(k.key).not.toContain(k.secretHash);
  });
  it('rejects malformed keys', () => {
    expect(parseApiKey('os_short_x')).toBeNull();
    expect(parseApiKey('Bearer x')).toBeNull();
  });
});

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, 2] } })).toBe(
      canonicalJson({ a: { c: [1, 2], d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('backoff', () => {
  it('grows exponentially and is bounded', () => {
    expect(backoffDelayMs(1, { baseMs: 1000, random: () => 1 })).toBe(1000);
    expect(backoffDelayMs(4, { baseMs: 1000, random: () => 1 })).toBe(8000);
    expect(backoffDelayMs(30, { baseMs: 1000, maxMs: 5000, random: () => 1 })).toBe(5000);
    expect(backoffDelayMs(3, { baseMs: 1000, random: () => 0 })).toBe(500);
  });
});

describe('redact', () => {
  it('removes credentials and masks addresses', () => {
    const out = redact(
      'auth failed password=hunter2 for user alice@example.org key os_abcdefghijkl_' +
        'x'.repeat(43),
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('alice@');
    expect(out).toContain('a***@example.org');
    expect(out).not.toContain('x'.repeat(43));
  });
});

describe('domain names', () => {
  it('normalizes IDN and case', () => {
    expect(normalizeDomain('Mail.Bücher.Example.')).toBe('mail.xn--bcher-kva.example');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('1.2.3.4')).toBeNull();
  });
  it('detects reserved local-only domains', () => {
    expect(isLocalOnlyDomain('app.test')).toBe(true);
    expect(isLocalOnlyDomain('example.com')).toBe(true);
    expect(isLocalOnlyDomain('acme.io')).toBe(false);
  });
});

describe('templates', () => {
  const vars = [
    { name: 'name', required: true, sample: 'Ada' },
    { name: 'plan', required: false, fallback: 'free' },
  ];
  it('escapes HTML and renders text raw', () => {
    const values = resolveValues(vars, { name: '<b>Ada</b>' }, 'send');
    const r = renderTemplate(
      { subject: 'Hi {{name}}', html: '<p>{{name}} on {{plan}}</p>', text: 'Hi {{name}}' },
      values,
    );
    expect(r.html).toBe('<p>&lt;b&gt;Ada&lt;&#x2F;b&gt; on free</p>');
    expect(r.text).toBe('Hi <b>Ada</b>');
  });
  it('rejects missing required and unknown variables', () => {
    expect(() => resolveValues(vars, {}, 'send')).toThrow(TemplateError);
    expect(() => resolveValues(vars, { name: 'x', other: 'y' }, 'send')).toThrow(/unknown/);
    expect(resolveValues(vars, {}, 'preview').name).toBe('Ada');
  });
  it('rejects undeclared and raw variables in sources', () => {
    expect(() => validateTemplateSource({ subject: '{{nope}}' }, vars)).toThrow(/undeclared/);
    expect(() => validateTemplateSource({ subject: 'x', html: '{{{name}}}' }, vars)).toThrow(
      /unescaped/,
    );
  });
  it('rejects subjects that render line breaks', () => {
    expect(() => renderTemplate({ subject: '{{name}}' }, { name: 'a\r\nBcc: x@y.test' })).toThrow(
      TemplateError,
    );
  });
});

describe('webhook signatures', () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ hello: 'world' });
  const now = 1_800_000_000_000;
  const ts = Math.floor(now / 1000);

  it('verifies the exact bytes', () => {
    const sig = signatureHeader([secret], 'evt_1', ts, body);
    expect(() =>
      verifyWebhook(secret, { id: 'evt_1', timestamp: String(ts), signature: sig }, body, { now }),
    ).not.toThrow();
    expect(() =>
      verifyWebhook(secret, { id: 'evt_1', timestamp: String(ts), signature: sig }, body + ' ', {
        now,
      }),
    ).toThrow(WebhookVerificationError);
  });
  it('rejects stale timestamps (replay window)', () => {
    const sig = signatureHeader([secret], 'evt_1', ts, body);
    expect(() =>
      verifyWebhook(secret, { id: 'evt_1', timestamp: String(ts), signature: sig }, body, {
        now: now + 10 * 60_000,
      }),
    ).toThrow(/tolerance/);
  });
  it('accepts any active secret during rotation', () => {
    const next = generateWebhookSecret();
    const sig = signatureHeader([next, secret], 'evt_2', ts, body);
    expect(() =>
      verifyWebhook(secret, { id: 'evt_2', timestamp: String(ts), signature: sig }, body, { now }),
    ).not.toThrow();
    expect(() =>
      verifyWebhook(next, { id: 'evt_2', timestamp: String(ts), signature: sig }, body, { now }),
    ).not.toThrow();
  });
});

import { uuidv7 } from './ids';
describe('uuidv7', () => {
  it('is a valid, time ordered UUID', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
