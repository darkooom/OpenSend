import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AcceptedEmailResponse,
  BatchResponse,
  DomainResource,
  EmailListItem,
  EmailListQuery,
  EmailResource,
  ErrorBody,
  SendEmailRequest,
  UsageResponse,
  WebhookEventEnvelope,
} from '@opensend/contracts';

export type {
  AcceptedEmailResponse,
  BatchResponse,
  DomainResource,
  EmailListItem,
  EmailResource,
  SendEmailRequest,
  UsageResponse,
  WebhookEventEnvelope,
};

export interface OpenSendOptions {
  /** Project/environment API key (`os_...`). Keep it on the server. */
  apiKey: string;
  /** Base URL of your OpenSend instance, e.g. https://opensend.example.com */
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Typed API error. `code` is the stable machine-readable error code. */
export class OpenSendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'OpenSendError';
  }
}

export interface RequestOptions {
  /** Makes retries of the same request safe (see docs/API.md#idempotency). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface SendResult extends AcceptedEmailResponse {
  /** True when the server returned the stored result of an earlier identical request. */
  replayed: boolean;
}

export class OpenSend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OpenSendOptions) {
    if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
      throw new Error(
        '@opensend/sdk must not be used in browser code: it would expose your API key.',
      );
    }
    if (!opts.apiKey?.startsWith('os_'))
      throw new Error('an OpenSend API key (os_...) is required');
    if (!opts.baseUrl) throw new Error('baseUrl is required (the URL of your OpenSend instance)');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    ro: RequestOptions = {},
  ): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (ro.idempotencyKey) headers['idempotency-key'] = ro.idempotencyKey;
    const signal = ro.signal ?? AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok && !(res.status === 422 && path === '/v1/emails/batch')) {
      const e = (json as ErrorBody | undefined)?.error;
      throw new OpenSendError(
        res.status,
        e?.code ?? 'http_error',
        e?.message ?? `HTTP ${res.status}`,
        e?.details,
        e?.requestId ?? res.headers.get('x-request-id') ?? undefined,
      );
    }
    return { data: json as T, headers: res.headers };
  }

  readonly emails = {
    /** Accept an email. Resolves when it is durably accepted — not when it is delivered. */
    send: async (email: SendEmailRequest, ro?: RequestOptions): Promise<SendResult> => {
      const { data, headers } = await this.request<AcceptedEmailResponse>(
        'POST',
        '/v1/emails',
        email,
        ro,
      );
      return { ...data, replayed: headers.get('idempotent-replayed') === 'true' };
    },
    sendBatch: async (emails: SendEmailRequest[], ro?: RequestOptions): Promise<BatchResponse> =>
      (await this.request<BatchResponse>('POST', '/v1/emails/batch', { emails }, ro)).data,
    get: async (id: string): Promise<EmailResource> =>
      (await this.request<EmailResource>('GET', `/v1/emails/${encodeURIComponent(id)}`)).data,
    list: async (
      query: Partial<EmailListQuery> = {},
    ): Promise<{ data: EmailListItem[]; nextCursor: string | null }> => {
      const qs = new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]): [string, string] => [k, String(v)]),
      );
      return (
        await this.request<{ data: EmailListItem[]; nextCursor: string | null }>(
          'GET',
          `/v1/emails${qs.size ? `?${qs}` : ''}`,
        )
      ).data;
    },
    cancel: async (id: string): Promise<EmailResource> =>
      (await this.request<EmailResource>('POST', `/v1/emails/${encodeURIComponent(id)}/cancel`))
        .data,
  };

  readonly domains = {
    list: async (): Promise<DomainResource[]> =>
      (await this.request<{ data: DomainResource[] }>('GET', '/v1/domains')).data.data,
    create: async (name: string): Promise<DomainResource> =>
      (await this.request<DomainResource>('POST', '/v1/domains', { name })).data,
    verify: async (id: string): Promise<DomainResource> =>
      (await this.request<DomainResource>('POST', `/v1/domains/${encodeURIComponent(id)}/verify`))
        .data,
  };

  readonly usage = {
    get: async (): Promise<UsageResponse> =>
      (await this.request<UsageResponse>('GET', '/v1/usage')).data,
  };
}

export class WebhookVerificationError extends Error {}

/**
 * Verify an OpenSend webhook. Pass the RAW request body (exact bytes) and the headers.
 * Throws WebhookVerificationError if the signature or timestamp is not valid.
 */
export function verifyWebhook(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined> | Headers,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): WebhookEventEnvelope {
  const get = (name: string): string | undefined => {
    if (typeof (headers as Headers).get === 'function')
      return (headers as Headers).get(name) ?? undefined;
    const v = (headers as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = get('opensend-webhook-id');
  const timestamp = get('opensend-webhook-timestamp');
  const signature = get('opensend-webhook-signature');
  if (!id || !timestamp || !signature)
    throw new WebhookVerificationError('missing OpenSend webhook headers');
  const ts = Number(timestamp);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (opts.toleranceSeconds ?? 300))
    throw new WebhookVerificationError('timestamp outside tolerance');
  if (!secret.startsWith('whsec_')) throw new WebhookVerificationError('invalid secret format');
  const mac = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'));
  mac.update(`${id}.${ts}.`);
  mac.update(rawBody);
  const expected = mac.digest();
  const match = signature.split(' ').some((part) => {
    const [v, sig] = part.split(',');
    if (v !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) throw new WebhookVerificationError('signature mismatch');
  const event = JSON.parse(
    Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody,
  ) as WebhookEventEnvelope;
  if (event.id !== id) throw new WebhookVerificationError('event id does not match header');
  return event;
}
