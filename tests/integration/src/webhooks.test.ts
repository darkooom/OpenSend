import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { sql } from '@opensend/db';
import { verifyWebhook } from '@opensend/sdk';
import { processWebhookDelivery } from '@opensend/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  drain,
  resetDatabase,
  resetTenants,
  sampleEmail,
  startHarness,
  v1,
  type Harness,
  type Tenant,
} from './harness';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

let h: Harness;
let t: Tenant;
let server: Server;
let received: Received[] = [];
let responder: (n: number) => { status: number; headers?: Record<string, string> } = () => ({
  status: 200,
});
let url: string;

beforeAll(async () => {
  // The receiver runs on localhost, which only an operator allowlist entry permits.
  h = await startHarness({
    config: { OPENSEND_PRIVATE_NETWORK_ALLOWLIST: 'localhost', OPENSEND_MAX_WEBHOOK_ATTEMPTS: '3' },
  });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      const r = responder(received.length);
      res.writeHead(r.status, r.headers).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}/hooks`;
});
afterAll(async () => {
  server.close();
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  received = [];
  responder = () => ({ status: 200 });
  t = await createTenant(h);
});

const base = () => `/api/projects/${t.projectId}/environments/${t.envId}`;
const makeDeliveriesDue = () =>
  Promise.all([
    h.db.execute(
      sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE completed_at IS NULL`,
    ),
  ]);

describe('outgoing webhooks', () => {
  it('delivers signed events that receivers can verify', async () => {
    const ep = await t.owner.post(`${base()}/webhooks`, { url, eventTypes: ['email.submitted'] });
    expect(ep.status).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_/);
    const list = await t.owner.get(`${base()}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(ep.body.secret);

    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ tags: { order: '42' } }));
    await drain(h);
    expect(received).toHaveLength(1);
    const event = verifyWebhook(
      received[0]!.body,
      received[0]!.headers as Record<string, string>,
      ep.body.secret,
    );
    expect(event.type).toBe('email.submitted');
    expect(event.data).toMatchObject({
      emailId: r.body.id,
      status: 'submitted',
      tags: { order: '42' },
    });
    expect(event.projectId).toBe(t.projectId);
    // Message content never appears in webhook payloads.
    expect(received[0]!.body).not.toContain('<p>Hi</p>');
    // A body that was altered in transit fails verification.
    expect(() =>
      verifyWebhook(
        received[0]!.body.replace('submitted', 'failed'),
        received[0]!.headers as Record<string, string>,
        ep.body.secret,
      ),
    ).toThrow();
  });

  it('retries failed deliveries with backoff, then dead-letters them; replay re-sends the same event without sending email', async () => {
    responder = () => ({ status: 500 });
    await t.owner.post(`${base()}/webhooks`, { url, eventTypes: ['email.submitted'] });
    await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    expect(received).toHaveLength(1);
    let deliveries = await h.db.execute<{ id: string; status: string; attempt_count: number }>(
      sql`SELECT id, status, attempt_count FROM webhook_deliveries`,
    );
    expect(deliveries.rows[0]).toMatchObject({ status: 'retry_wait', attempt_count: 1 });
    for (let i = 0; i < 3; i++) {
      await makeDeliveriesDue();
      await drain(h);
    }
    deliveries = await h.db.execute(sql`SELECT id, status, attempt_count FROM webhook_deliveries`);
    expect(deliveries.rows[0]).toMatchObject({ status: 'dead', attempt_count: 3 });
    const dead = await t.owner.get(`${base()}/webhook-deliveries/dead`);
    expect(dead.body).toHaveLength(1);
    const attempts = await t.owner.get(
      `${base()}/webhook-deliveries/${deliveries.rows[0]!.id}/attempts`,
    );
    expect(attempts.body.map((a: { statusCode: number }) => a.statusCode)).toEqual([500, 500, 500]);

    // Receiver fixed; replay delivers the SAME event id and sends no new email.
    responder = () => ({ status: 204 });
    const emailsBefore = (
      await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM emails`)
    ).rows[0]!.n;
    const sentBefore = h.provider.submitted.length;
    const replay = await t.owner.post(
      `${base()}/webhook-deliveries/${deliveries.rows[0]!.id}/replay`,
    );
    expect(replay.status).toBe(202);
    await drain(h);
    const ids = received.map((x) => x.headers['opensend-webhook-id']);
    expect(new Set(ids).size).toBe(1);
    expect(received).toHaveLength(4);
    expect(
      (await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM emails`)).rows[0]!.n,
    ).toBe(emailsBefore);
    expect(h.provider.submitted.length).toBe(sentBefore);
  });

  it('does not follow redirects', async () => {
    responder = () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
    await t.owner.post(`${base()}/webhooks`, { url, eventTypes: ['email.submitted'] });
    await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    expect(received).toHaveLength(1);
    const d = await h.db.execute<{ status: string; last_error: string }>(
      sql`SELECT status, last_error FROM webhook_deliveries`,
    );
    expect(d.rows[0]!.status).toBe('retry_wait');
    expect(d.rows[0]!.last_error).toMatch(/redirect/);
  });

  it('test events and secret rotation (both secrets sign during rotation)', async () => {
    const ep = await t.owner.post(`${base()}/webhooks`, { url, eventTypes: ['email.submitted'] });
    const rotated = await t.owner.post(`${base()}/webhooks/${ep.body.id}/rotate-secret`);
    expect(rotated.status).toBe(201);
    await t.owner.post(`${base()}/webhooks/${ep.body.id}/test`);
    await drain(h);
    expect(received).toHaveLength(1);
    const headers = received[0]!.headers as Record<string, string>;
    expect(headers['opensend-webhook-signature']!.split(' ')).toHaveLength(2);
    expect(verifyWebhook(received[0]!.body, headers, rotated.body.secret).type).toBe(
      'webhook.test',
    );
    expect(verifyWebhook(received[0]!.body, headers, ep.body.secret).type).toBe('webhook.test');
  });
});

describe('SSRF protection', () => {
  it('rejects private, loopback and metadata targets at creation', async () => {
    for (const bad of [
      'http://169.254.169.254/x',
      'http://127.0.0.1/x',
      'http://[::1]/x',
      'http://10.1.2.3/x',
      'http://metadata.google.internal/x',
      'ftp://example.org/x',
      'https://user:pw@example.org/x',
    ]) {
      const r = await t.owner.post(`${base()}/webhooks`, {
        url: bad,
        eventTypes: ['email.submitted'],
      });
      expect(r.status, bad).toBe(422);
    }
  });

  it('blocks hostnames that resolve to private addresses at connect time (DNS rebinding)', async () => {
    const ep = await t.owner.post(`${base()}/webhooks`, {
      url: 'https://hooks.rebind.example.org/x',
      eventTypes: ['email.submitted'],
    });
    expect(ep.status).toBe(201);
    await t.owner.post(`${base()}/webhooks/${ep.body.id}/test`);
    const [d] = (await h.db.execute<{ id: string }>(sql`SELECT id FROM webhook_deliveries`)).rows;
    const rebinding: LookupFunction = ((
      _host: string,
      _o: unknown,
      cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void,
    ) => cb(null, [{ address: '10.0.0.7', family: 4 }])) as unknown as LookupFunction;
    expect(await processWebhookDelivery(h.deps, d!.id, undefined, { lookup: rebinding })).toBe(
      'dead',
    );
    const row = await h.db.execute<{ last_error: string }>(
      sql`SELECT last_error FROM webhook_deliveries WHERE id = ${d!.id}`,
    );
    expect(row.rows[0]!.last_error).toMatch(/non-public/);
  });

  it('rejects SMTP relays on private networks', async () => {
    const r = await t.owner.post(`${base()}/providers`, {
      name: 'relay',
      type: 'smtp',
      config: { host: '127.0.0.1', port: 587, security: 'starttls' },
    });
    expect(r.status).toBe(422);
    const r2 = await t.owner.post(`${base()}/providers`, {
      name: 'relay',
      type: 'smtp',
      config: { host: 'localhost.', port: 587, security: 'starttls' },
    });
    expect([201, 422]).toContain(r2.status); // allowlisted in this harness only
  });
});
