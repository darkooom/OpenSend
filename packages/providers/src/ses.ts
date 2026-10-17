import {
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';
import type { DnsRecord } from '@opensend/contracts';
import { redact } from '@opensend/core';
import MailComposer from 'nodemailer/lib/mail-composer';
import { z } from 'zod';
import type {
  DomainSetupResult,
  OutgoingMessage,
  ProviderAdapter,
  ProviderCapabilities,
  StatusLookupResult,
  SubmitResult,
} from './types';

export const sesConfigSchema = z.object({
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'invalid AWS region'),
  /** Configuration set with an SNS event destination for Delivery/Bounce/Complaint events. */
  configurationSetName: z.string().max(64).optional(),
  /** SNS topic ARNs whose notifications are accepted for this connection. */
  snsTopicArns: z
    .array(z.string().regex(/^arn:aws(-[a-z]+)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/))
    .default([]),
});
export const sesSecretsSchema = z.object({
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(256),
});
export type SesConfig = z.infer<typeof sesConfigSchema>;

type SesClientLike = Pick<SESv2Client, 'send' | 'destroy'>;

interface AwsError extends Error {
  name: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
  $fault?: 'client' | 'server';
}

const PERMANENT_NAMES = [
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
  'NotFoundException',
  'BadRequestException',
  'InvalidParameterValue',
];
const THROTTLE_NAMES = [
  'TooManyRequestsException',
  'LimitExceededException',
  'ThrottlingException',
  'Throttling',
];
const AUTH_NAMES = [
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'AccessDeniedException',
  'CredentialsProviderError',
];
/** Network errors that happen before a request could reach SES. */
const PRE_SEND_NETWORK = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
];

export function classifySesError(err: AwsError): SubmitResult {
  const code = err.name || err.code || 'Error';
  const message = redact(err.message) ?? code;
  const status = err.$metadata?.httpStatusCode;
  if (THROTTLE_NAMES.includes(code) || status === 429) {
    return { outcome: 'transient_failure', category: 'throttled', code, message };
  }
  if (AUTH_NAMES.includes(code) || status === 403) {
    return { outcome: 'transient_failure', category: 'authentication', code, message };
  }
  if (PERMANENT_NAMES.includes(code) || (status && status >= 400 && status < 500)) {
    return { outcome: 'permanent_failure', category: 'provider_rejected', code, message };
  }
  if (status && status >= 500) {
    // SES answered with an error, so it did not accept the message.
    return { outcome: 'transient_failure', category: 'provider_error', code, message };
  }
  if (PRE_SEND_NETWORK.includes(err.code ?? '') || PRE_SEND_NETWORK.includes(code)) {
    return { outcome: 'transient_failure', category: 'connection', code, message };
  }
  // Timeouts, resets and aborted requests: SES may have accepted the message.
  return {
    outcome: 'unknown',
    category: code.toLowerCase().includes('timeout') ? 'timeout' : 'unknown',
    code,
    message,
  };
}

function sanitizeTag(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_';
}

export interface SesAdapterOptions {
  timeoutMs: number;
  /** Injected client for tests. */
  client?: SesClientLike;
}

export class SesAdapter implements ProviderAdapter {
  readonly type = 'ses' as const;
  readonly capabilities: ProviderCapabilities = {
    send: true,
    domainVerification: true,
    deliveryEvents: true,
    // SES offers no API to look up a message by id after an unclear submission.
    statusLookup: false,
  };
  private readonly client: SesClientLike;

  constructor(
    private readonly config: SesConfig,
    secrets: z.infer<typeof sesSecretsSchema>,
    opts: SesAdapterOptions,
  ) {
    this.client =
      opts.client ??
      new SESv2Client({
        region: config.region,
        credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
        // SendEmail is not idempotent: an SDK-level retry after a timeout could send twice.
        maxAttempts: 1,
        requestHandler: {
          requestTimeout: opts.timeoutMs,
          connectionTimeout: Math.min(opts.timeoutMs, 10_000),
        },
      });
  }

  async buildRawMessage(message: OutgoingMessage): Promise<Buffer> {
    const composer = new MailComposer({
      messageId: message.messageId,
      from: message.from.name
        ? { name: message.from.name, address: message.from.email }
        : message.from.email,
      to: message.to,
      cc: message.cc,
      // Bcc is passed via Destination only and never written into the headers.
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
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return new Promise((resolve, reject) =>
      composer.compile().build((err, buf) => (err ? reject(err) : resolve(buf))),
    );
  }

  async submit(message: OutgoingMessage): Promise<SubmitResult> {
    let raw: Buffer;
    try {
      raw = await this.buildRawMessage(message);
    } catch (err) {
      return {
        outcome: 'permanent_failure',
        category: 'configuration',
        code: 'mime_build_failed',
        message: redact((err as Error).message) ?? 'failed',
      };
    }
    let out: SendEmailCommandOutput;
    try {
      out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: message.from.email,
          Destination: {
            ToAddresses: message.to,
            CcAddresses: message.cc,
            BccAddresses: message.bcc,
          },
          Content: { Raw: { Data: raw } },
          ConfigurationSetName: this.config.configurationSetName,
          EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({
            Name: sanitizeTag(Name),
            Value: sanitizeTag(Value),
          })),
        }),
      );
    } catch (err) {
      return classifySesError(err as AwsError);
    }
    return {
      outcome: 'accepted',
      providerMessageId: out.MessageId ?? null,
      acceptedRecipients: [...message.to, ...message.cc, ...message.bcc],
      rejectedRecipients: [],
    };
  }

  async lookupStatus(): Promise<StatusLookupResult> {
    return { status: 'unsupported' };
  }

  /** Reads (and optionally creates) the SES domain identity and reports the DKIM CNAMEs SES issued. */
  async setupDomain(domain: string, opts: { create: boolean }): Promise<DomainSetupResult> {
    let identity;
    try {
      identity = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    } catch (err) {
      if (!(err instanceof NotFoundException) && (err as AwsError).name !== 'NotFoundException') {
        return {
          status: 'failed',
          records: [],
          message: redact((err as Error).message) ?? 'SES request failed',
        };
      }
      if (!opts.create)
        return {
          status: 'not_started',
          records: [],
          message: 'Identity does not exist in SES yet',
        };
      try {
        await this.client.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
        identity = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      } catch (createErr) {
        return {
          status: 'failed',
          records: [],
          message: redact((createErr as Error).message) ?? 'SES request failed',
        };
      }
    }
    const tokens = identity.DkimAttributes?.Tokens ?? [];
    const records: DnsRecord[] = tokens.map((t) => ({
      purpose: 'dkim',
      type: 'CNAME',
      name: `${t}._domainkey.${domain}`,
      value: `${t}.dkim.amazonses.com`,
      required: true,
      status: 'unknown',
      found: [],
    }));
    const dkim = identity.DkimAttributes?.Status;
    const verified = identity.VerifiedForSendingStatus === true;
    const status = verified
      ? 'verified'
      : dkim === 'FAILED' || dkim === 'TEMPORARY_FAILURE'
        ? 'failed'
        : 'pending';
    return {
      status,
      records,
      message: verified
        ? 'SES reports the identity as verified for sending'
        : `SES DKIM status: ${dkim ?? 'unknown'}`,
    };
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      const acct = await this.client.send(new GetAccountCommand({}));
      const sending = acct.SendingEnabled ? 'sending enabled' : 'sending disabled';
      const sandbox = acct.ProductionAccessEnabled
        ? 'production access'
        : 'SES sandbox (only verified recipients)';
      return {
        ok: Boolean(acct.SendingEnabled),
        message: `Credentials valid; ${sending}; ${sandbox}`,
      };
    } catch (err) {
      return { ok: false, message: redact((err as Error).message) ?? 'SES request failed' };
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
