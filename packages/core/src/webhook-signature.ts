import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature scheme (v1):
 *   signed content = `${webhookId}.${timestamp}.${rawBody}`
 *   signature      = base64(HMAC-SHA256(secretBytes, signed content))
 *   header         = `v1,<signature>` (space separated when several secrets are active during rotation)
 * Secrets look like `whsec_<base64>`; the bytes after the prefix are the HMAC key.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function secretBytes(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) throw new Error('invalid webhook secret format');
  return Buffer.from(secret.slice('whsec_'.length), 'base64');
}

export function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  rawBody: string | Buffer,
): string {
  const mac = createHmac('sha256', secretBytes(secret));
  mac.update(`${id}.${timestamp}.`);
  mac.update(rawBody);
  return `v1,${mac.digest('base64')}`;
}

export function signatureHeader(
  secrets: string[],
  id: string,
  timestamp: number,
  rawBody: string | Buffer,
): string {
  return secrets.map((s) => signWebhook(s, id, timestamp, rawBody)).join(' ');
}

export class WebhookVerificationError extends Error {}

/** Reference verifier (also exported through the SDK). Rejects stale timestamps to limit replays. */
export function verifyWebhook(
  secret: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  rawBody: string | Buffer,
  opts: { toleranceSeconds?: number; now?: number } = {},
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature)
    throw new WebhookVerificationError('missing webhook headers');
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) throw new WebhookVerificationError('invalid timestamp');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - ts) > tolerance)
    throw new WebhookVerificationError('timestamp outside tolerance');
  const expected = Buffer.from(signWebhook(secret, id, ts, rawBody).slice(3), 'base64');
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return;
  }
  throw new WebhookVerificationError('no matching signature');
}
