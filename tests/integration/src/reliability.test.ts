import { sql } from '@opensend/db';
import {
  QUEUES,
  clarifyUnknownSubmissions,
  dispatchOutbox,
  processSendEmail,
  reapExpiredLeases,
} from '@opensend/worker';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IT } from './env';
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

let h: Harness;
let t: Tenant;
beforeAll(async () => {
  h = await startHarness({ config: { OPENSEND_MAX_SEND_ATTEMPTS: '3' } });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h);
});

const status = async (id: string) => (await v1(h, t.apiKey).get(`/v1/emails/${id}`)).body;
const makeDue = (id: string) =>
  Promise.all([
    h.db.execute(
      sql`UPDATE emails SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`,
    ),
    h.db.execute(
      sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE ref_id = ${id} AND completed_at IS NULL`,
    ),
  ]);

describe('durability: Redis loss and worker restart', () => {
  it('accepted jobs are recovered from PostgreSQL after Redis loses its data', async () => {
    const redis = new Redis(IT.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue(QUEUES.send_email, { connection: redis, prefix: 'opensend-it' });
    try {
      const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
      expect(r.status).toBe(202);
      const enqueue = async (
        _k: string,
        payload: { outboxId: number; refId: string },
        jobId: string,
      ) => {
        await queue.add('send_email', payload, {
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
        });
      };
      expect(await dispatchOutbox(h.deps, enqueue)).toBe(1);
      expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });

      // Redis loses everything before any worker picked the job up.
      await redis.flushdb();
      expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
      // Not re-dispatched while within the grace window...
      expect(await dispatchOutbox(h.deps, enqueue)).toBe(0);
      // ...but recovered from the outbox afterwards.
      expect(await dispatchOutbox(h.deps, enqueue, { redispatchAfterSeconds: 0 })).toBe(1);
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data.refId).toBe(r.body.id);
      // Job payload carries ids only.
      expect(Object.keys(jobs[0]!.data).sort()).toEqual(['outboxId', 'refId']);

      // A fresh worker processes it.
      await processSendEmail(h.deps, jobs[0]!.data.refId, jobs[0]!.data.outboxId);
      expect((await status(r.body.id)).status).toBe('submitted');
      expect(h.provider.submitted).toHaveLength(1);
      // A redispatch after completion does not send again.
      expect(await dispatchOutbox(h.deps, enqueue, { redispatchAfterSeconds: 0 })).toBe(0);
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      redis.disconnect();
    }
  });

  it('a duplicate job for an already processed email is a no-op', async () => {
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    expect(await processSendEmail(h.deps, r.body.id)).toBe('not_claimable');
    expect(h.provider.submitted).toHaveLength(1);
  });

  it('an expired lease (crashed worker) becomes submission_unknown and is never resent automatically', async () => {
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    // Simulate a worker that claimed the job and died before recording the outcome.
    await h.db.execute(
      sql`UPDATE emails SET status = 'submitting', attempt_count = 1, lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 second' WHERE id = ${r.body.id}`,
    );
    await h.db.execute(
      sql`INSERT INTO send_attempts (email_id, project_id, attempt_number, worker_id) SELECT id, project_id, 1, 'dead-worker' FROM emails WHERE id = ${r.body.id}`,
    );
    expect(await reapExpiredLeases(h.deps)).toBe(1);
    const e = await status(r.body.id);
    expect(e.status).toBe('submission_unknown');
    expect(e.lastError.code).toBe('lease_expired');
    await h.db.execute(
      sql`UPDATE outbox SET dispatched_at = NULL, available_at = now() - interval '1 hour'`,
    );
    await drain(h);
    expect(h.provider.submitted).toHaveLength(0);
  });
});

describe('retries and unclear outcomes', () => {
  it('retries transient failures with backoff and then succeeds', async () => {
    h.provider.next({
      outcome: 'transient_failure',
      category: 'connection',
      code: 'econnection',
      message: 'connection refused',
    });
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    let e = await status(r.body.id);
    expect(e.status).toBe('retry_wait');
    expect(e.attempts).toBe(1);
    // Not retried before the backoff elapsed.
    await drain(h);
    expect(h.provider.submitted).toHaveLength(1);
    await makeDue(r.body.id);
    await drain(h);
    e = await status(r.body.id);
    expect(e.status).toBe('submitted');
    expect(e.attempts).toBe(2);
    expect(h.provider.submitted).toHaveLength(2);
  });

  it('gives up after the maximum number of attempts', async () => {
    const fail = {
      outcome: 'transient_failure' as const,
      category: 'throttled' as const,
      code: 'smtp_421',
      message: 'try later',
    };
    h.provider.next(fail, fail, fail);
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    for (let i = 0; i < 3; i++) {
      await drain(h);
      await makeDue(r.body.id);
    }
    const e = await status(r.body.id);
    expect(e.status).toBe('failed');
    expect(e.attempts).toBe(3);
    expect(e.recipients[0].status).toBe('failed');
  });

  it('permanent failures are not retried', async () => {
    h.provider.next({
      outcome: 'permanent_failure',
      category: 'provider_rejected',
      code: 'smtp_554',
      message: 'rejected',
    });
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    await makeDue(r.body.id);
    await drain(h);
    expect((await status(r.body.id)).status).toBe('failed');
    expect(h.provider.submitted).toHaveLength(1);
  });

  it('a timeout after possible acceptance becomes submission_unknown without blind resend', async () => {
    h.provider.next({
      outcome: 'unknown',
      category: 'timeout',
      code: 'etimedout',
      message: 'timeout after DATA',
    });
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    expect((await status(r.body.id)).status).toBe('submission_unknown');
    await makeDue(r.body.id);
    await h.db.execute(sql`UPDATE outbox SET dispatched_at = NULL`);
    await drain(h);
    expect(h.provider.submitted).toHaveLength(1);

    // Resend requires an explicit duplicate confirmation and creates a NEW linked email.
    const base = `/api/projects/${t.projectId}/environments/${t.envId}`;
    const blocked = await t.owner.post(`${base}/emails/${r.body.id}/resend`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.requiresConfirmation).toBe(true);
    const resent = await t.owner.post(`${base}/emails/${r.body.id}/resend`, {
      confirmDuplicate: true,
    });
    expect(resent.status).toBe(202);
    expect(resent.body.id).not.toBe(r.body.id);
    const detail = await t.owner.get(`${base}/emails/${resent.body.id}`);
    expect(detail.body.resendOf).toBe(r.body.id);
    const audit = await t.owner.get(`/api/orgs/${t.orgId}/audit`);
    expect(audit.body.some((x: { action: string }) => x.action === 'email.resend')).toBe(true);
  });

  it('provider status lookup resolves unknown submissions (accepted or confirmed absent)', async () => {
    h.provider.next(
      { outcome: 'unknown', category: 'timeout', code: 'etimedout', message: 'timeout' },
      { outcome: 'unknown', category: 'timeout', code: 'etimedout', message: 'timeout' },
    );
    const r1 = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    const r2 = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    h.provider.lookup = { status: 'accepted', providerMessageId: 'mp-1' };
    await h.db.execute(
      sql`UPDATE emails SET finalized_at = now() - interval '10 minutes' WHERE id = ${r2.body.id}`,
    );
    // First email: provider confirms acceptance.
    await h.db.execute(sql`UPDATE emails SET status = 'failed' WHERE id = ${r2.body.id}`);
    await clarifyUnknownSubmissions(h.deps);
    expect((await status(r1.body.id)).status).toBe('submitted');
    // Second email: provider confirms it never received it (after the grace period).
    await h.db.execute(
      sql`UPDATE emails SET status = 'submission_unknown' WHERE id = ${r2.body.id}`,
    );
    h.provider.lookup = { status: 'not_found' };
    await clarifyUnknownSubmissions(h.deps);
    expect((await status(r2.body.id)).status).toBe('failed');
    expect(h.provider.submitted).toHaveLength(2);
  });
});

describe('scheduling and cancellation', () => {
  it('scheduled emails are never handed off early', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ scheduledAt: at }));
    expect(r.body.status).toBe('scheduled');
    await drain(h);
    expect(h.provider.submitted).toHaveLength(0);
    // Even a stray job for it does nothing before the time.
    expect(await processSendEmail(h.deps, r.body.id)).toBe('postponed');
    expect(h.provider.submitted).toHaveLength(0);
    // Once due, it is sent.
    await h.db.execute(
      sql`UPDATE emails SET scheduled_at = now() - interval '1 second' WHERE id = ${r.body.id}`,
    );
    await h.db.execute(
      sql`UPDATE outbox SET available_at = now() - interval '1 second' WHERE ref_id = ${r.body.id}`,
    );
    await drain(h);
    expect((await status(r.body.id)).status).toBe('submitted');
  });

  it('rejects schedules too far ahead or in the past', async () => {
    expect(
      (
        await v1(h, t.apiKey).post(
          '/v1/emails',
          sampleEmail({ scheduledAt: new Date(Date.now() + 40 * 86_400_000).toISOString() }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await v1(h, t.apiKey).post(
          '/v1/emails',
          sampleEmail({ scheduledAt: '2020-01-01T00:00:00Z' }),
        )
      ).status,
    ).toBe(422);
  });

  it('cancels scheduled emails and refuses to cancel after hand-off', async () => {
    const r = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const c = await v1(h, t.apiKey).post(`/v1/emails/${r.body.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    await h.db.execute(sql`UPDATE emails SET scheduled_at = now() - interval '1 second'`);
    await h.db.execute(sql`UPDATE outbox SET available_at = now() - interval '1 second'`);
    await drain(h);
    expect(h.provider.submitted).toHaveLength(0);

    const r2 = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    const c2 = await v1(h, t.apiKey).post(`/v1/emails/${r2.body.id}/cancel`);
    expect(c2.status).toBe(409);
    expect(c2.body.error.code).toBe('not_cancellable');
  });

  it('concurrent cancel and processing never both win', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++)
      ids.push(
        (await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ subject: `race ${i}` }))).body.id,
      );
    await Promise.all(
      ids.flatMap((id) => [
        processSendEmail(h.deps, id),
        v1(h, t.apiKey).post(`/v1/emails/${id}/cancel`),
      ]),
    );
    const rows = await h.db.execute<{ id: string; status: string }>(
      sql`SELECT id, status FROM emails`,
    );
    const sentIds = new Set(h.provider.submitted.map((m) => m.headers['X-OpenSend-Email-Id']));
    for (const row of rows.rows) {
      expect(['cancelled', 'submitted']).toContain(row.status);
      if (row.status === 'cancelled') expect(sentIds.has(row.id)).toBe(false);
      if (row.status === 'submitted') expect(sentIds.has(row.id)).toBe(true);
    }
    expect(h.provider.submitted.length).toBe(
      rows.rows.filter((r) => r.status === 'submitted').length,
    );
  });
});
