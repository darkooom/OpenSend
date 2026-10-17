import {
  BlockedTargetError,
  isHostAllowlisted,
  redact,
  resolveSafeAddress,
  type TargetPolicy,
} from '@opensend/core';
import nodemailer from 'nodemailer';
import { fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type {
  DomainSetupResult,
  FailureCategory,
  OutgoingMessage,
  ProviderAdapter,
  ProviderCapabilities,
  StatusLookupResult,
  SubmitResult,
} from './types';

export const smtpConfigSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** `tls`: implicit TLS (465). `starttls`: upgrade required. Plaintext relays are not supported. */
  security: z.enum(['tls', 'starttls']),
  username: z.string().max(320).optional(),
});
export const smtpSecretsSchema = z.object({ password: z.string().max(1000).optional() });
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;

interface SmtpError extends Error {
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  rejected?: string[];
}

const PRE_DATA_COMMANDS = [
  'CONN',
  'EHLO',
  'HELO',
  'LHLO',
  'STARTTLS',
  'AUTH',
  'MAIL FROM',
  'RCPT TO',
];
const PRE_DATA_CODES = [
  'ECONNECTION',
  'EDNS',
  'ETLS',
  'EAUTH',
  'ENOAUTH',
  'ECONFIG',
  'EENVELOPE',
  'EPROXY',
];

/**
 * Classify a nodemailer error. The important distinction: an error with an explicit SMTP reply
 * or one that happened before the DATA phase means the message was NOT accepted. A timeout or
 * socket error during/after DATA may mean the server accepted it, so the result is `unknown`.
 */
export function classifySmtpError(err: SmtpError): SubmitResult {
  const code = err.code ?? 'ERROR';
  const message = redact(err.response ?? err.message) ?? 'SMTP error';
  const command = (err.command ?? '').toUpperCase();
  const beforeData =
    PRE_DATA_COMMANDS.some((c) => command.startsWith(c)) || PRE_DATA_CODES.includes(code);

  if (err instanceof BlockedTargetError || (err as { code?: string }).code === 'blocked_target') {
    return {
      outcome: 'permanent_failure',
      category: 'blocked_target',
      code: 'blocked_target',
      message,
    };
  }
  if (err.responseCode && err.responseCode >= 500) {
    const category: FailureCategory = command.startsWith('RCPT')
      ? 'recipients_rejected'
      : command.startsWith('AUTH')
        ? 'authentication'
        : 'provider_rejected';
    return {
      outcome: 'permanent_failure',
      category,
      code: `smtp_${err.responseCode}`,
      message,
      rejectedRecipients: err.rejected?.map((address) => ({ address, reason: message })),
    };
  }
  if (err.responseCode && err.responseCode >= 400) {
    return {
      outcome: 'transient_failure',
      category: 'throttled',
      code: `smtp_${err.responseCode}`,
      message,
    };
  }
  if (code === 'EAUTH' || code === 'ENOAUTH') {
    return {
      outcome: 'transient_failure',
      category: 'authentication',
      code: code.toLowerCase(),
      message,
    };
  }
  if (beforeData) {
    return {
      outcome: 'transient_failure',
      category: code === 'ETIMEDOUT' ? 'timeout' : 'connection',
      code: code.toLowerCase(),
      message,
    };
  }
  return {
    outcome: 'unknown',
    category: code === 'ETIMEDOUT' ? 'timeout' : 'unknown',
    code: code.toLowerCase(),
    message,
  };
}

interface TransportTarget {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
}

export interface SmtpAdapterOptions {
  timeoutMs: number;
  policy: TargetPolicy;
  /** Only for tests: skip address resolution. */
  resolve?: (host: string) => Promise<string>;
}

/** Shared SMTP implementation used by the generic relay and the local Mailpit provider. */
abstract class BaseSmtpAdapter implements ProviderAdapter {
  abstract readonly type: 'local' | 'smtp';
  abstract readonly capabilities: ProviderCapabilities;

  protected constructor(
    protected readonly target: TransportTarget,
    protected readonly opts: SmtpAdapterOptions,
  ) {}

  protected async createTransport() {
    // Resolve and validate the relay address ourselves, then connect to that exact IP.
    // TLS still validates the certificate against the configured hostname (servername).
    const address = this.opts.resolve
      ? await this.opts.resolve(this.target.host)
      : await resolveSafeAddress(this.target.host, this.opts.policy);
    const secure = this.target.security === 'tls';
    return nodemailer.createTransport({
      host: address,
      port: this.target.port,
      secure,
      requireTLS: this.target.security === 'starttls',
      ignoreTLS: this.target.security === 'none',
      tls: { servername: this.target.host, minVersion: 'TLSv1.2', rejectUnauthorized: true },
      auth: this.target.username
        ? { user: this.target.username, pass: this.target.password ?? '' }
        : undefined,
      connectionTimeout: this.opts.timeoutMs,
      greetingTimeout: this.opts.timeoutMs,
      socketTimeout: this.opts.timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async submit(message: OutgoingMessage): Promise<SubmitResult> {
    let transport;
    try {
      transport = await this.createTransport();
    } catch (err) {
      return classifySmtpError(err as SmtpError);
    }
    const envelopeTo = [...message.to, ...message.cc, ...message.bcc];
    try {
      const info = await transport.sendMail({
        messageId: message.messageId,
        from: message.from.name
          ? { name: message.from.name, address: message.from.email }
          : message.from.email,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: message.replyTo.length ? message.replyTo : undefined,
        subject: message.subject,
        html: message.html ?? undefined,
        text: message.text ?? undefined,
        headers: message.headers,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          cid: a.contentId,
        })),
        envelope: { from: message.from.email, to: envelopeTo },
      });
      const accepted = (info.accepted as Array<string | { address: string }>).map((a) =>
        typeof a === 'string' ? a : a.address,
      );
      const rejected = (info.rejected as Array<string | { address: string }>).map((a) =>
        typeof a === 'string' ? a : a.address,
      );
      return {
        outcome: 'accepted',
        // SMTP has no provider message id beyond the queue id in the response text.
        providerMessageId: null,
        acceptedRecipients: accepted,
        rejectedRecipients: rejected.map((address) => ({ address, reason: 'rejected by relay' })),
        response: redact(info.response, 300) ?? undefined,
      };
    } catch (err) {
      return classifySmtpError(err as SmtpError);
    } finally {
      transport.close();
    }
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      const transport = await this.createTransport();
      try {
        await transport.verify();
        return { ok: true, message: 'Connection and authentication succeeded' };
      } finally {
        transport.close();
      }
    } catch (err) {
      return { ok: false, message: redact((err as Error).message) ?? 'connection failed' };
    }
  }

  async lookupStatus(_m: {
    messageId: string;
    providerMessageId: string | null;
  }): Promise<StatusLookupResult> {
    return { status: 'unsupported' };
  }

  abstract setupDomain(domain: string, opts: { create: boolean }): Promise<DomainSetupResult>;

  async close(): Promise<void> {}
}

/** Generic SMTP relay. Delivery events are not available from plain SMTP. */
export class SmtpAdapter extends BaseSmtpAdapter {
  readonly type = 'smtp' as const;
  readonly capabilities: ProviderCapabilities = {
    send: true,
    domainVerification: false,
    deliveryEvents: false,
    statusLookup: false,
  };

  constructor(config: SmtpConfig, secrets: { password?: string }, opts: SmtpAdapterOptions) {
    super({ ...config, password: secrets.password }, opts);
  }

  async setupDomain(_domain: string): Promise<DomainSetupResult> {
    return {
      status: 'unsupported',
      records: [],
      message:
        'A generic SMTP relay does not expose its DKIM/sender requirements. Configure DKIM and sender authorization with your relay provider; OpenSend checks ownership and SPF only.',
    };
  }
}

export interface LocalAdapterOptions extends SmtpAdapterOptions {
  smtpHost: string;
  smtpPort: number;
  apiUrl: string;
}

/**
 * Local development provider: real SMTP delivery into the operator-configured Mailpit.
 * Host and port come from server configuration only, never from tenant input.
 */
export class LocalMailpitAdapter extends BaseSmtpAdapter {
  readonly type = 'local' as const;
  readonly capabilities: ProviderCapabilities = {
    send: true,
    domainVerification: false,
    deliveryEvents: false,
    statusLookup: true,
  };

  constructor(private readonly local: LocalAdapterOptions) {
    super(
      { host: local.smtpHost, port: local.smtpPort, security: 'none' },
      {
        ...local,
        // The operator configured this host explicitly, so it may be private (docker network / localhost).
        policy: {
          privateHostAllowlist: [...(local.policy.privateHostAllowlist ?? []), local.smtpHost],
        },
      },
    );
    if (!isHostAllowlisted(local.smtpHost, this.opts.policy))
      throw new Error('mailpit host must be allowlisted');
  }

  /** Asks Mailpit whether it received a message with our Message-ID. */
  override async lookupStatus(m: {
    messageId: string;
    providerMessageId: string | null;
  }): Promise<StatusLookupResult> {
    const id = m.messageId.replace(/^<|>$/g, '');
    const url = new URL('/api/v1/search', this.local.apiUrl);
    url.searchParams.set('query', `message-id:"${id}"`);
    url.searchParams.set('limit', '1');
    const res = await undiciFetch(url, { signal: AbortSignal.timeout(this.local.timeoutMs) });
    if (!res.ok) throw new Error(`mailpit lookup failed with HTTP ${res.status}`);
    const body = (await res.json()) as {
      messages_count?: number;
      messages?: Array<{ ID: string }>;
    };
    const first = body.messages?.[0];
    return first ? { status: 'accepted', providerMessageId: first.ID } : { status: 'not_found' };
  }

  async setupDomain(_domain: string): Promise<DomainSetupResult> {
    return {
      status: 'not_required',
      records: [],
      message: 'Local development delivery does not need DNS records.',
    };
  }
}
