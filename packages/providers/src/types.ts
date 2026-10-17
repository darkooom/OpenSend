import type { DnsRecord } from '@opensend/contracts';

export interface ProviderCapabilities {
  /** Can hand messages to a transport. */
  send: boolean;
  /** Provider exposes domain identity verification (e.g. DKIM tokens). */
  domainVerification: boolean;
  /** Provider reports per-recipient delivery events (delivered / bounced / complained). */
  deliveryEvents: boolean;
  /** Provider can answer "did you accept message X?" after an unclear submission. */
  statusLookup: boolean;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  contentId?: string;
}

export interface OutgoingMessage {
  /** RFC 5322 Message-ID including angle brackets. */
  messageId: string;
  from: { email: string; name?: string };
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  headers: Record<string, string>;
  attachments: OutgoingAttachment[];
  tags: Record<string, string>;
}

export type FailureCategory =
  | 'connection'
  | 'timeout'
  | 'authentication'
  | 'configuration'
  | 'throttled'
  | 'provider_rejected'
  | 'recipients_rejected'
  | 'provider_error'
  | 'blocked_target'
  | 'unknown';

export type SubmitResult =
  | {
      outcome: 'accepted';
      providerMessageId: string | null;
      acceptedRecipients: string[];
      rejectedRecipients: Array<{ address: string; reason: string }>;
      response?: string;
    }
  /** Definitely not accepted; safe to retry. */
  | { outcome: 'transient_failure'; category: FailureCategory; code: string; message: string }
  /** Definitely not accepted; retrying will not help. */
  | {
      outcome: 'permanent_failure';
      category: FailureCategory;
      code: string;
      message: string;
      rejectedRecipients?: Array<{ address: string; reason: string }>;
    }
  /** The provider may or may not have accepted the message. Never retried automatically. */
  | { outcome: 'unknown'; category: FailureCategory; code: string; message: string };

export type StatusLookupResult =
  | { status: 'accepted'; providerMessageId: string | null }
  | { status: 'not_found' }
  | { status: 'unsupported' };

export interface DomainSetupResult {
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'not_required' | 'unsupported';
  records: DnsRecord[];
  message?: string;
}

export interface ProviderAdapter {
  readonly type: 'local' | 'smtp' | 'ses';
  readonly capabilities: ProviderCapabilities;
  submit(message: OutgoingMessage): Promise<SubmitResult>;
  lookupStatus(message: {
    messageId: string;
    providerMessageId: string | null;
  }): Promise<StatusLookupResult>;
  /** Create/inspect the provider-side identity for a domain and report the DNS records it requires. */
  setupDomain(domain: string, opts: { create: boolean }): Promise<DomainSetupResult>;
  /** Cheap connectivity/credential check used by the dashboard "Test connection" action. */
  verify(): Promise<{ ok: boolean; message: string }>;
  close(): Promise<void>;
}
