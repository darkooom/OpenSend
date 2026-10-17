import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpenSend, OpenSendError, verifyWebhook, WebhookVerificationError } from './index';

describe('OpenSend client', () => {
  it('sends with idempotency key and maps replay header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenSend({
      apiKey: 'os_abcdefghijkl_x',
      baseUrl: 'https://mail.example.org/',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ id: 'e1', object: 'email', status: 'queued', scheduledAt: null }),
          { status: 202, headers: { 'idempotent-replayed': 'true' } },
        );
      }) as typeof fetch,
    });
    const r = await client.emails.send(
      { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' },
      { idempotencyKey: 'k1' },
    );
    expect(r).toMatchObject({ id: 'e1', replayed: true });
    expect(calls[0]!.url).toBe('https://mail.example.org/v1/emails');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('k1');
  });

  it('throws typed errors', async () => {
    const client = new OpenSend({
      apiKey: 'os_abcdefghijkl_x',
      baseUrl: 'https://mail.example.org',
      fetch: (async () =>
        new Response(
          JSON.stringify({ error: { code: 'quota_exceeded', message: 'monthly quota exceeded' } }),
          { status: 429 },
        )) as unknown as typeof fetch,
    });
    await expect(client.emails.get('x')).rejects.toMatchObject({
      status: 429,
      code: 'quota_exceeded',
    });
    await expect(client.emails.get('x')).rejects.toBeInstanceOf(OpenSendError);
  });
});

describe('verifyWebhook', () => {
  const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  const body = JSON.stringify({
    id: 'evt1',
    type: 'email.submitted',
    version: 1,
    createdAt: 'x',
    projectId: 'p',
    environmentId: 'e',
    data: {},
  });
  const ts = 1_800_000_000;
  const sig = `v1,${createHmac('sha256', Buffer.alloc(32, 9)).update(`evt1.${ts}.${body}`).digest('base64')}`;
  const headers = {
    'opensend-webhook-id': 'evt1',
    'opensend-webhook-timestamp': String(ts),
    'opensend-webhook-signature': sig,
  };

  it('accepts a valid signature', () => {
    expect(verifyWebhook(body, headers, secret, { now: ts * 1000 }).type).toBe('email.submitted');
  });
  it('rejects tampered bodies and old timestamps', () => {
    expect(() =>
      verifyWebhook(body.replace('submitted', 'failed'), headers, secret, { now: ts * 1000 }),
    ).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook(body, headers, secret, { now: (ts + 3600) * 1000 })).toThrow(
      /tolerance/,
    );
  });
});
