import { sql } from '@opensend/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  resetDatabase,
  resetTenants,
  sampleEmail,
  startHarness,
  v1,
  type Harness,
  type Tenant,
} from './harness';

let h: Harness;
let t: Tenant;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h);
});

const count = async (table: string) =>
  Number(
    (await h.db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]!
      .n,
  );

describe('Idempotency-Key', () => {
  it('parallel requests with the same key create exactly one email', async () => {
    const body = sampleEmail({ to: ['a@example.test', 'b@example.test'] });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        v1(h, t.apiKey).post('/v1/emails', body, { 'idempotency-key': 'order-42' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 202)).toBe(true);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await count('emails')).toBe(1);
    expect(await count('outbox')).toBe(1);
    // Usage counted once.
    const usage = await v1(h, t.apiKey).get('/v1/usage');
    expect(usage.body.acceptedEmails).toBe(1);
    expect(usage.body.acceptedRecipients).toBe(2);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true').length).toBe(11);
  });

  it('same key with a different body is a 409 conflict; normalized key order is irrelevant', async () => {
    const first = await v1(h, t.apiKey).post(
      '/v1/emails',
      { subject: 'S', text: 'T', from: 'hello@acme.test', to: 'x@example.test' },
      { 'idempotency-key': 'k' },
    );
    expect(first.status).toBe(202);
    const reordered = await v1(h, t.apiKey).post(
      '/v1/emails',
      { to: 'x@example.test', from: 'hello@acme.test', text: 'T', subject: 'S' },
      { 'idempotency-key': 'k' },
    );
    expect(reordered.status).toBe(202);
    expect(reordered.body.id).toBe(first.body.id);
    const changed = await v1(h, t.apiKey).post(
      '/v1/emails',
      { to: 'x@example.test', from: 'hello@acme.test', text: 'T2', subject: 'S' },
      { 'idempotency-key': 'k' },
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('idempotency_conflict');
    expect(await count('emails')).toBe(1);
  });

  it('parallel requests with the same key but different bodies: one wins, the others conflict', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        v1(h, t.apiKey).post('/v1/emails', sampleEmail({ subject: `S${i}` }), {
          'idempotency-key': 'race',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await count('emails')).toBe(1);
  });

  it('keys are scoped per environment / project', async () => {
    const other = await createTenant(h, { domain: 'other.test' });
    const r1 = await v1(h, t.apiKey).post('/v1/emails', sampleEmail(), {
      'idempotency-key': 'shared',
    });
    const r2 = await v1(h, other.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@other.test' }),
      { 'idempotency-key': 'shared' },
    );
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r1.body.id).not.toBe(r2.body.id);
  });

  it('a rejected request leaves no idempotency record or reservation behind', async () => {
    const bad = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@unknown.test' }),
      { 'idempotency-key': 'k2' },
    );
    expect(bad.status).toBe(422);
    expect(await count('idempotency_keys')).toBe(0);
    const usage = await v1(h, t.apiKey).get('/v1/usage');
    expect(usage.body.acceptedEmails).toBe(0);
    // The same key can now be used for a valid request.
    expect(
      (await v1(h, t.apiKey).post('/v1/emails', sampleEmail(), { 'idempotency-key': 'k2' })).status,
    ).toBe(202);
  });

  it('expired keys are kept while the email is still pending', async () => {
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail(), {
      'idempotency-key': 'long',
    });
    await h.db.execute(sql`UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'`);
    const again = await v1(h, t.apiKey).post('/v1/emails', sampleEmail(), {
      'idempotency-key': 'long',
    });
    expect(again.status).toBe(202);
    expect(again.body.id).toBe(r.body.id);
    expect(await count('emails')).toBe(1);
  });
});

describe('batch', () => {
  it('accepts valid items, reports per-item errors and is idempotent per item', async () => {
    const body = {
      emails: [
        sampleEmail({ subject: 'one' }),
        sampleEmail({ from: 'nope' }),
        sampleEmail({ subject: 'three' }),
      ],
    };
    const r = await v1(h, t.apiKey).post('/v1/emails/batch', body, {
      'idempotency-key': 'batch-1',
    });
    expect(r.status).toBe(202);
    expect(r.body.data.map((d: { index: number }) => d.index)).toEqual([0, 2]);
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].index).toBe(1);
    expect(r.body.errors[0].error.code).toBe('validation_error');

    const retry = await v1(h, t.apiKey).post('/v1/emails/batch', body, {
      'idempotency-key': 'batch-1',
    });
    expect(retry.body.data.map((d: { id: string }) => d.id)).toEqual(
      r.body.data.map((d: { id: string }) => d.id),
    );
    expect(await count('emails')).toBe(2);
  });

  it('returns 422 when no item could be accepted and enforces the batch size', async () => {
    const r = await v1(h, t.apiKey).post('/v1/emails/batch', {
      emails: [sampleEmail({ from: 'x' })],
    });
    expect(r.status).toBe(422);
    const tooMany = await v1(h, t.apiKey).post('/v1/emails/batch', {
      emails: Array.from({ length: h.config.OPENSEND_MAX_BATCH_SIZE + 1 }, () => sampleEmail()),
    });
    expect(tooMany.status).toBe(422);
  });
});
