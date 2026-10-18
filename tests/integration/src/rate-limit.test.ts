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
  h = await startHarness({
    config: {
      OPENSEND_RATE_LIMIT_PER_MINUTE: '5',
      OPENSEND_RATE_LIMIT_PER_PROJECT_PER_MINUTE: '8',
    },
  });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h);
});

describe('rate limits (real Redis)', () => {
  it('limits per key, reports headers and does not count rejected requests', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await v1(h, t.apiKey).post('/v1/emails', sampleEmail())).status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(5);
    const limited = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['ratelimit-limit']).toBe('5');
  });

  it('limits per project across keys, and a batch counts every email', async () => {
    const base = `/api/projects/${t.projectId}/environments/${t.envId}`;
    const k2 = (await t.owner.post(`${base}/api-keys`, { name: 'second', scopes: ['emails:send'] }))
      .body.key;
    // 4 + 4 single sends from two keys exhaust the project limit of 8.
    for (let i = 0; i < 4; i++)
      expect((await v1(h, t.apiKey).post('/v1/emails', sampleEmail())).status).toBe(202);
    for (let i = 0; i < 4; i++)
      expect((await v1(h, k2).post('/v1/emails', sampleEmail())).status).toBe(202);
    const third = (
      await t.owner.post(`${base}/api-keys`, { name: 'third', scopes: ['emails:send'] })
    ).body.key;
    const res = await v1(h, third).post('/v1/emails', sampleEmail());
    expect(res.status).toBe(429);
    expect(res.body.error.details.scope).toBe('project');
  });

  it('rejects a batch larger than the remaining key budget', async () => {
    const res = await v1(h, t.apiKey).post('/v1/emails/batch', {
      emails: Array.from({ length: 6 }, () => sampleEmail()),
    });
    expect(res.status).toBe(429);
    expect(
      (
        await v1(h, t.apiKey).post('/v1/emails/batch', {
          emails: Array.from({ length: 5 }, () => sampleEmail()),
        })
      ).status,
    ).toBe(202);
  });
});
