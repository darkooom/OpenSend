import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * SSRF protection for outbound connections to tenant-supplied targets (webhooks, SMTP relays).
 * The address check happens inside the DNS lookup used for the actual connection, so a
 * hostname cannot resolve to a public IP during validation and a private IP when connecting.
 */
export class BlockedTargetError extends Error {
  readonly code = 'blocked_target';
}

const BLOCKED_HOSTNAMES = ['localhost', 'metadata.google.internal', 'metadata'];

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  // Only globally routable unicast is acceptable. Everything else (private, loopback,
  // link-local incl. 169.254.169.254 metadata, CGNAT, multicast, reserved, ...) is blocked.
  return addr.range() === 'unicast';
}

export interface TargetPolicy {
  /** Operator allowlist of hostnames that may resolve to non-public addresses. */
  privateHostAllowlist?: string[];
}

export function isHostAllowlisted(host: string, policy: TargetPolicy): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (policy.privateHostAllowlist ?? []).some((a) => a.toLowerCase() === h);
}

export function assertHostnameShape(host: string, policy: TargetPolicy): void {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isHostAllowlisted(h, policy)) return;
  if (
    BLOCKED_HOSTNAMES.includes(h) ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    throw new BlockedTargetError(`target host "${host}" is not allowed`);
  }
  if (isIP(h) && !isPublicAddress(h))
    throw new BlockedTargetError(`target address "${host}" is not public`);
}

/** A dns.lookup replacement that refuses non-public results unless the host is allowlisted. */
export function createGuardedLookup(
  policy: TargetPolicy,
  base: LookupFunction = dnsLookup as LookupFunction,
): LookupFunction {
  return ((hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    const opts = (typeof options === 'object' && options !== null ? options : {}) as Record<
      string,
      unknown
    >;
    try {
      assertHostnameShape(hostname, policy);
    } catch (err) {
      cb(err as NodeJS.ErrnoException, '', 0);
      return;
    }
    base(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = (
        Array.isArray(addresses)
          ? addresses
          : [{ address: addresses as unknown as string, family: 4 }]
      ) as Array<{
        address: string;
        family: number;
      }>;
      const allowPrivate = isHostAllowlisted(hostname, policy);
      const bad = list.find((a) => !allowPrivate && !isPublicAddress(a.address));
      if (bad || list.length === 0) {
        return cb(
          new BlockedTargetError(
            `target "${hostname}" resolves to a non-public address`,
          ) as NodeJS.ErrnoException,
          '',
          0,
        );
      }
      if (opts.all) return cb(null, list);
      const first = list[0]!;
      return cb(null, first.address, first.family);
    });
  }) as LookupFunction;
}

/** Resolve a host once, validating every address; returns the address to connect to. */
export async function resolveSafeAddress(
  host: string,
  policy: TargetPolicy,
  base?: LookupFunction,
): Promise<string> {
  const lookup = createGuardedLookup(policy, base);
  return new Promise((resolve, reject) => {
    lookup(host, { all: false }, (err, address) =>
      err ? reject(err) : resolve(address as string),
    );
  });
}

export interface SafeFetchOptions extends TargetPolicy {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  allowHttp?: boolean;
  lookup?: LookupFunction;
  maxResponseBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  body: string;
}

/** fetch() for untrusted URLs: no redirects, guarded DNS at connect time, timeout, bounded body. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new BlockedTargetError(`protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password)
    throw new BlockedTargetError('credentials in URL are not allowed');
  assertHostnameShape(url.hostname.replace(/^\[|\]$/g, ''), opts);
  const agent = new Agent({
    connect: { lookup: createGuardedLookup(opts, opts.lookup), timeout: opts.timeoutMs },
    headersTimeout: opts.timeoutMs,
    bodyTimeout: opts.timeoutMs,
  });
  try {
    const res = await undiciFetch(url, {
      method: opts.method ?? 'POST',
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      dispatcher: agent,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const max = opts.maxResponseBytes ?? 4096;
    let body = '';
    if (res.body) {
      const reader = res.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (body.length < max) body += Buffer.from(value).toString('utf8');
        if (total > max * 4) {
          await reader.cancel();
          break;
        }
      }
    }
    return { status: res.status, body: body.slice(0, max) };
  } catch (err) {
    // undici wraps connect errors as `TypeError: fetch failed` with the real error as cause.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof BlockedTargetError) throw cause;
    if (cause instanceof Error) throw new Error(`${(err as Error).message}: ${cause.message}`);
    throw err;
  } finally {
    await agent.close();
  }
}
