import type { LookupFunction } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BlockedTargetError, isPublicAddress, resolveSafeAddress, safeFetch } from './network';

function fakeDns(map: Record<string, string[]>): LookupFunction {
  return ((
    host: string,
    _opts: unknown,
    cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void,
  ) => {
    const addrs = map[host];
    if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(
      null,
      addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })),
    );
  }) as unknown as LookupFunction;
}

describe('isPublicAddress', () => {
  it.each([
    ['10.0.0.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['192.168.1.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['0.0.0.0', false],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('guarded DNS resolution', () => {
  it('blocks hosts resolving to private addresses (incl. mixed answers)', async () => {
    const dns = fakeDns({
      'evil.example.org': ['8.8.8.8', '10.0.0.5'],
      'ok.example.org': ['8.8.4.4'],
    });
    await expect(resolveSafeAddress('evil.example.org', {}, dns)).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await expect(resolveSafeAddress('ok.example.org', {}, dns)).resolves.toBe('8.8.4.4');
  });
  it('allows explicitly allowlisted internal hosts only', async () => {
    const dns = fakeDns({ mailpit: ['172.18.0.4'] });
    await expect(resolveSafeAddress('mailpit', {}, dns)).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(
      resolveSafeAddress('mailpit', { privateHostAllowlist: ['mailpit'] }, dns),
    ).resolves.toBe('172.18.0.4');
  });
  it('blocks metadata and loopback literals', async () => {
    await expect(resolveSafeAddress('169.254.169.254', {})).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await expect(resolveSafeAddress('localhost', {})).rejects.toBeInstanceOf(BlockedTargetError);
  });
});

describe('safeFetch', () => {
  it('refuses http, credentials and private literal targets before connecting', async () => {
    await expect(safeFetch('http://example.org/hook', { timeoutMs: 1000 })).rejects.toThrow(
      /protocol/,
    );
    await expect(safeFetch('https://u:p@example.org/hook', { timeoutMs: 1000 })).rejects.toThrow(
      /credentials/,
    );
    await expect(safeFetch('https://127.0.0.1/hook', { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await expect(safeFetch('https://[::1]/hook', { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  });
  it('blocks DNS-rebinding style hostnames at connect time', async () => {
    const dns = fakeDns({ 'rebind.example.org': ['127.0.0.1'] });
    await expect(
      safeFetch('https://rebind.example.org/hook', { timeoutMs: 2000, lookup: dns }),
    ).rejects.toThrow();
  });
});

describe('address preference', () => {
  it('prefers IPv4 when a single address is requested', async () => {
    const dns = fakeDns({ 'dual.example.org': ['2606:4700::1', '8.8.8.8'] });
    await expect(resolveSafeAddress('dual.example.org', {}, dns)).resolves.toBe('8.8.8.8');
    const v6only = fakeDns({ 'v6.example.org': ['2606:4700::1'] });
    await expect(resolveSafeAddress('v6.example.org', {}, v6only)).resolves.toBe('2606:4700::1');
  });
});
