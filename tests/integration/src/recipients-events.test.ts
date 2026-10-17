import { sql } from '@opensend/db';
import { reconcileProviderEvents } from '@opensend/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  drain,
  resetDatabase,
  resetTenants,
  startHarness,
  v1,
  type Harness,
} from './harness';
import { postSns, sesTenant, snsNotification, useFakeSnsCertificates } from './ses';

let h: Harness;
let t: Awaited<ReturnType<typeof sesTenant>>;
beforeAll(async () => {
  h = await startHarness();
  useFakeSnsCertificates();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await sesTenant(h, createTenant);
});

const send = (to: string[], extra: Record<string, unknown> = {}) =>
  v1(h, t.apiKey).post('/v1/emails', {
    from: `Acme <hello@${t.domain}>`,
    to,
    subject: 'Hi',
    text: 'Hello',
    ...extra,
  });
const get = async (id: string) => (await v1(h, t.apiKey).get(`/v1/emails/${id}`)).body;
const usage = async () => (await v1(h, t.apiKey).get('/v1/usage')).body;
const ses = (eventType: string, messageId: string, body: Record<string, unknown>) => ({
  eventType,
  mail: { messageId, timestamp: new Date().toISOString() },
  ...body,
});

describe('multiple recipients', () => {
  it('tracks each recipient independently and aggregates without over-claiming', async () => {
    h.provider.next((m) => ({
      outcome: 'accepted',
      providerMessageId: 'ses-1',
      acceptedRecipients: [...m.to, ...m.cc],
      rejectedRecipients: [{ address: 'c@example.org', reason: '550 no such user' }],
    }));
    const r = await send(['a@example.org', 'b@example.org', 'c@example.org'], {
      cc: ['d@example.org'],
    });
    expect(r.status).toBe(202);
    await drain(h);
    let e = await get(r.body.id);
    expect(e.status).toBe('submitted');
    expect(e.summary).toMatchObject({ total: 4, submitted: 3, rejected: 1, delivered: 0 });
    expect(e.displayStatus).toBe('submitted');

    await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Delivery', 'ses-1', {
          delivery: { recipients: ['a@example.org'], timestamp: new Date().toISOString() },
        }),
      ),
    );
    await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Bounce', 'ses-1', {
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'b@example.org' }],
          },
        }),
      ),
    );
    await drain(h);
    e = await get(r.body.id);
    expect(e.summary).toMatchObject({ delivered: 1, bounced: 1, rejected: 1 });
    expect(e.displayStatus).toBe('partially_bounced');
    const byAddr = Object.fromEntries(e.recipients.map((x: { address: string }) => [x.address, x]));
    expect(byAddr['a@example.org'].deliveredAt).not.toBeNull();
    expect(byAddr['b@example.org'].bounceType).toBe('permanent');
    expect(byAddr['c@example.org'].status).toBe('rejected');
    // Usage counts accepted recipients once, independent of events.
    expect((await usage()).acceptedRecipients).toBe(4);
  });
});

describe('provider events', () => {
  it('ignores duplicate notifications and keeps usage unchanged', async () => {
    h.provider.next({
      outcome: 'accepted',
      providerMessageId: 'ses-dup',
      acceptedRecipients: ['a@example.org'],
      rejectedRecipients: [],
    });
    const r = await send(['a@example.org']);
    await drain(h);
    const msg = snsNotification(
      ses('Delivery', 'ses-dup', { delivery: { recipients: ['a@example.org'] } }),
      { messageId: 'same-sns-id' },
    );
    for (let i = 0; i < 3; i++) expect((await postSns(h, t.connectionId, msg)).status).toBe(200);
    await drain(h);
    const events = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM email_events WHERE email_id = ${r.body.id} AND type = 'recipient.delivered'`,
    );
    expect(events.rows[0]!.n).toBe(1);
    const stored = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provider_events`,
    );
    expect(stored.rows[0]!.n).toBe(1);
    expect((await usage()).acceptedRecipients).toBe(1);
  });

  it('keeps events that arrive before the email is known and applies them later', async () => {
    h.provider.next({
      outcome: 'accepted',
      providerMessageId: 'ses-early',
      acceptedRecipients: ['a@example.org'],
      rejectedRecipients: [],
    });
    const r = await send(['a@example.org']);
    // The delivery notification overtakes our own bookkeeping.
    await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Delivery', 'ses-early', { delivery: { recipients: ['a@example.org'] } }),
      ),
    );
    await drain(h); // processes the event (unmatched) and the send job
    let e = await get(r.body.id);
    expect(e.status).toBe('submitted');
    const pe = await h.db.execute<{ match_status: string }>(
      sql`SELECT match_status FROM provider_events`,
    );
    expect(['unmatched', 'matched']).toContain(pe.rows[0]!.match_status);
    await reconcileProviderEvents(h.deps);
    e = await get(r.body.id);
    expect(e.recipients[0].deliveredAt).not.toBeNull();
  });

  it('never loses unmatchable events and never matches across tenants', async () => {
    const other = await createTenant(h, { domain: 'other.test' });
    h.provider.next({
      outcome: 'accepted',
      providerMessageId: 'ses-a',
      acceptedRecipients: ['a@example.org'],
      rejectedRecipients: [],
    });
    const r = await send(['a@example.org']);
    await drain(h);
    // Unknown message id: stored as unmatched.
    await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Delivery', 'does-not-exist', { delivery: { recipients: ['x@example.org'] } }),
      ),
    );
    await drain(h);
    const unmatched = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provider_events WHERE match_status = 'unmatched'`,
    );
    expect(unmatched.rows[0]!.n).toBe(1);
    // Another tenant cannot inject events for this email: their connection is not an SES one /
    // a valid signature from a non-configured topic is rejected.
    const foreign = await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Bounce', 'ses-a', {
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'a@example.org' }],
          },
        }),
        { topic: 'arn:aws:sns:eu-central-1:999999999999:attacker' },
      ),
    );
    expect(foreign.status).toBe(403);
    const otherConns = await other.owner.get(
      `/api/projects/${other.projectId}/environments/${other.envId}/providers`,
    );
    expect(
      (await postSns(h, otherConns.body.data[0].id, snsNotification(ses('Bounce', 'ses-a', {}))))
        .status,
    ).toBe(404);
    expect((await get(r.body.id)).recipients[0].bouncedAt).toBeNull();
    // Unsigned / tampered messages are rejected.
    const tampered = snsNotification(
      ses('Delivery', 'ses-a', { delivery: { recipients: ['a@example.org'] } }),
    );
    tampered.Message = tampered.Message.replace('Delivery', 'Complaint');
    expect((await postSns(h, t.connectionId, tampered)).status).toBe(403);
  });

  it('a later complaint does not erase the earlier delivery; hard bounces and complaints suppress', async () => {
    h.provider.next({
      outcome: 'accepted',
      providerMessageId: 'ses-c',
      acceptedRecipients: ['a@example.org', 'b@example.org'],
      rejectedRecipients: [],
    });
    const r = await send(['a@example.org', 'b@example.org']);
    await drain(h);
    await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Delivery', 'ses-c', { delivery: { recipients: ['a@example.org', 'b@example.org'] } }),
      ),
    );
    await postSns(
      h,
      t.connectionId,
      snsNotification(
        ses('Complaint', 'ses-c', {
          complaint: { complainedRecipients: [{ emailAddress: 'a@example.org' }] },
        }),
      ),
    );
    await drain(h);
    const e = await get(r.body.id);
    const a = e.recipients.find((x: { address: string }) => x.address === 'a@example.org');
    expect(a.deliveredAt).not.toBeNull();
    expect(a.complainedAt).not.toBeNull();
    expect(e.summary.delivered).toBe(2);
    expect(e.displayStatus).toBe('complained');
    const timeline = await t.owner.get(
      `/api/projects/${t.projectId}/environments/${t.envId}/emails/${r.body.id}`,
    );
    const types = timeline.body.timeline.map((x: { type: string }) => x.type);
    expect(types).toContain('recipient.delivered');
    expect(types).toContain('recipient.complained');

    // Complained address is now suppressed for the next email.
    const r2 = await send(['a@example.org', 'b@example.org']);
    await drain(h);
    const e2 = await get(r2.body.id);
    expect(
      e2.recipients.find((x: { address: string }) => x.address === 'a@example.org').status,
    ).toBe('suppressed');
    const last = h.provider.submitted[h.provider.submitted.length - 1]!;
    expect(last.to).toEqual(['b@example.org']);
  });
});
