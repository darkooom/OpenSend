import { X509Certificate, createVerify } from 'node:crypto';
import { redact } from '@opensend/core';
import { fetch as undiciFetch } from 'undici';
import { z } from 'zod';

/**
 * Amazon SNS message verification (HTTP/S subscriptions), following the documented
 * algorithm: canonical string of selected fields, RSA signature (SignatureVersion 1 = SHA1,
 * 2 = SHA256), certificate downloaded only from an `sns.<region>.amazonaws.com` HTTPS URL.
 */
export const snsMessageSchema = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: z.string().min(1).max(200),
  TopicArn: z.string().min(1).max(512),
  Message: z.string(),
  Timestamp: z.string(),
  SignatureVersion: z.enum(['1', '2']),
  Signature: z.string().min(1),
  SigningCertURL: z.string().url(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().url().optional(),
  Token: z.string().optional(),
  UnsubscribeURL: z.string().optional(),
});
export type SnsMessage = z.infer<typeof snsMessageSchema>;

export class SnsVerificationError extends Error {}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isTrustedSnsUrl(raw: string, kind: 'cert' | 'subscribe'): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  if (!SNS_HOST.test(url.hostname)) return false;
  if (kind === 'cert' && !url.pathname.endsWith('.pem')) return false;
  return true;
}

export function snsStringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? [
          'Message',
          'MessageId',
          ...(m.Subject !== undefined ? ['Subject'] : []),
          'Timestamp',
          'TopicArn',
          'Type',
        ]
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${(m as Record<string, string | undefined>)[k] ?? ''}\n`).join('');
}

export type CertFetcher = (url: string) => Promise<string>;

const certCache = new Map<string, { pem: string; at: number }>();
export const defaultCertFetcher: CertFetcher = async (url) => {
  const cached = certCache.get(url);
  if (cached && Date.now() - cached.at < 60 * 60_000) return cached.pem;
  const res = await undiciFetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new SnsVerificationError(`certificate download failed (${res.status})`);
  const pem = await res.text();
  if (pem.length > 20_000) throw new SnsVerificationError('certificate too large');
  certCache.set(url, { pem, at: Date.now() });
  return pem;
};

export interface SnsVerifyOptions {
  allowedTopicArns: string[];
  fetchCert?: CertFetcher;
  now?: number;
  maxAgeSeconds?: number;
}

export async function verifySnsMessage(body: unknown, opts: SnsVerifyOptions): Promise<SnsMessage> {
  const parsed = snsMessageSchema.safeParse(body);
  if (!parsed.success) throw new SnsVerificationError('not a valid SNS message');
  const m = parsed.data;
  if (!opts.allowedTopicArns.includes(m.TopicArn))
    throw new SnsVerificationError('topic is not allowed');
  if (!isTrustedSnsUrl(m.SigningCertURL, 'cert'))
    throw new SnsVerificationError('untrusted signing certificate URL');
  const ts = Date.parse(m.Timestamp);
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (opts.maxAgeSeconds ?? 3600) * 1000) {
    throw new SnsVerificationError('message timestamp outside accepted window');
  }
  const pem = await (opts.fetchCert ?? defaultCertFetcher)(m.SigningCertURL);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new SnsVerificationError('invalid signing certificate');
  }
  const verifier = createVerify(m.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
  verifier.update(snsStringToSign(m), 'utf8');
  if (!verifier.verify(cert.publicKey, m.Signature, 'base64'))
    throw new SnsVerificationError('invalid signature');
  return m;
}

/* -------------------------------------------------------------------------- */
/* SES event normalization                                                    */
/* -------------------------------------------------------------------------- */

export type NormalizedEventType =
  'delivered' | 'bounced' | 'complained' | 'deferred' | 'rejected' | 'sent' | 'other';

export interface NormalizedProviderEvent {
  externalId: string;
  providerMessageId: string | null;
  eventType: NormalizedEventType;
  occurredAt: Date | null;
  recipients: Array<{
    address: string;
    detail?: string;
    bounceType?: 'permanent' | 'transient' | 'undetermined';
  }>;
  /** Redacted copy: no message headers/subject, diagnostic text redacted. */
  payload: Record<string, unknown>;
}

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string; destination?: string[] };
  delivery?: { timestamp?: string; recipients?: string[]; smtpResponse?: string };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    timestamp?: string;
    bouncedRecipients?: Array<{ emailAddress: string; diagnosticCode?: string; status?: string }>;
  };
  complaint?: {
    timestamp?: string;
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress: string }>;
  };
  deliveryDelay?: {
    timestamp?: string;
    delayType?: string;
    delayedRecipients?: Array<{ emailAddress: string; diagnosticCode?: string }>;
  };
  reject?: { reason?: string };
}

export function normalizeSesEvent(
  externalId: string,
  messageJson: string,
): NormalizedProviderEvent {
  let ev: SesEvent;
  try {
    ev = JSON.parse(messageJson) as SesEvent;
  } catch {
    return {
      externalId,
      providerMessageId: null,
      eventType: 'other',
      occurredAt: null,
      recipients: [],
      payload: { unparseable: true },
    };
  }
  const kind = (ev.eventType ?? ev.notificationType ?? '').toLowerCase();
  const providerMessageId = ev.mail?.messageId ?? null;
  const at = (s?: string) => (s && Number.isFinite(Date.parse(s)) ? new Date(s) : null);
  const base = { externalId, providerMessageId };
  const payloadBase = {
    eventType: ev.eventType ?? ev.notificationType,
    messageId: providerMessageId,
    mailTimestamp: ev.mail?.timestamp,
  };

  switch (kind) {
    case 'delivery':
      return {
        ...base,
        eventType: 'delivered',
        occurredAt: at(ev.delivery?.timestamp),
        recipients: (ev.delivery?.recipients ?? []).map((address) => ({ address })),
        payload: { ...payloadBase, smtpResponse: redact(ev.delivery?.smtpResponse, 200) },
      };
    case 'bounce': {
      const t = (ev.bounce?.bounceType ?? '').toLowerCase();
      const bounceType =
        t === 'permanent' ? 'permanent' : t === 'transient' ? 'transient' : 'undetermined';
      return {
        ...base,
        eventType: 'bounced',
        occurredAt: at(ev.bounce?.timestamp),
        recipients: (ev.bounce?.bouncedRecipients ?? []).map((r) => ({
          address: r.emailAddress,
          bounceType,
          detail: redact(r.diagnosticCode, 200) ?? undefined,
        })),
        payload: {
          ...payloadBase,
          bounceType: ev.bounce?.bounceType,
          bounceSubType: ev.bounce?.bounceSubType,
        },
      };
    }
    case 'complaint':
      return {
        ...base,
        eventType: 'complained',
        occurredAt: at(ev.complaint?.timestamp),
        recipients: (ev.complaint?.complainedRecipients ?? []).map((r) => ({
          address: r.emailAddress,
        })),
        payload: { ...payloadBase, feedbackType: ev.complaint?.complaintFeedbackType },
      };
    case 'deliverydelay':
      return {
        ...base,
        eventType: 'deferred',
        occurredAt: at(ev.deliveryDelay?.timestamp),
        recipients: (ev.deliveryDelay?.delayedRecipients ?? []).map((r) => ({
          address: r.emailAddress,
          detail: redact(r.diagnosticCode, 200) ?? undefined,
        })),
        payload: { ...payloadBase, delayType: ev.deliveryDelay?.delayType },
      };
    case 'reject':
      return {
        ...base,
        eventType: 'rejected',
        occurredAt: at(ev.mail?.timestamp),
        recipients: (ev.mail?.destination ?? []).map((address) => ({
          address,
          detail: ev.reject?.reason,
        })),
        payload: { ...payloadBase, reason: ev.reject?.reason },
      };
    case 'send':
      return {
        ...base,
        eventType: 'sent',
        occurredAt: at(ev.mail?.timestamp),
        recipients: [],
        payload: payloadBase,
      };
    default:
      return {
        ...base,
        eventType: 'other',
        occurredAt: at(ev.mail?.timestamp),
        recipients: [],
        payload: payloadBase,
      };
  }
}
