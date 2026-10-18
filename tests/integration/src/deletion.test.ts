import { sql } from '@opensend/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  WEB_ORIGIN,
  createTenant,
  drain,
  resetDatabase,
  resetTenants,
  sampleEmail,
  signIn,
  startHarness,
  v1,
  type Harness,
  type Tenant,
} from './harness';

let h: Harness;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  a = await createTenant(h, { domain: 'acme.test' });
  b = await createTenant(h, { domain: 'b.test' });
});

const attachment = { filename: 'x.txt', content: Buffer.from('secret').toString('base64') };
const n = async (q: ReturnType<typeof sql>) =>
  Number((await h.db.execute<{ n: number }>(q)).rows[0]!.n);

async function secondProject(t: Tenant, domain: string) {
  const p = await t.owner.post(`/api/orgs/${t.orgId}/projects`, {
    name: 'Second',
    environments: [
      { name: 'development', kind: 'development' },
      { name: 'staging', kind: 'staging' },
    ],
  });
  const env = p.body.environments[0].id;
  const base = `/api/projects/${p.body.id}/environments/${env}`;
  await t.owner.post(`${base}/providers`, { name: 'L', type: 'local' });
  await t.owner.post(`${base}/domains`, { name: domain });
  const key = (
    await t.owner.post(`${base}/api-keys`, { name: 'k', scopes: ['emails:send', 'emails:read'] })
  ).body.key as string;
  return {
    projectId: p.body.id as string,
    envId: env as string,
    stagingId: p.body.environments[1].id as string,
    key,
  };
}

describe('deleting scopes', () => {
  it('deletes a project with its data and objects, leaving other projects and tenants intact', async () => {
    const p2 = await secondProject(a, 'second.test');
    await h.db.execute(sql`UPDATE projects SET attachment_retention_days = 30`);
    await v1(h, a.apiKey).post('/v1/emails', sampleEmail({ attachments: [attachment] }));
    await v1(h, p2.key).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@second.test', attachments: [attachment] }),
    );
    await v1(h, b.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@b.test', attachments: [attachment] }),
    );
    expect(h.store.objects.size).toBe(3);

    // Pending email blocks deletion.
    const blocked = await a.owner.delete(`/api/projects/${p2.projectId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.pending.queued).toBe(1);
    await drain(h);

    const res = await a.owner.delete(`/api/projects/${p2.projectId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, emails: 1, objects: 1 });
    expect((await a.owner.get(`/api/projects/${p2.projectId}`)).status).toBe(404);
    expect(
      (await v1(h, p2.key).post('/v1/emails', sampleEmail({ from: 'hello@second.test' }))).status,
    ).toBe(401);
    expect(h.store.objects.size).toBe(2);
    expect(
      await n(sql`SELECT count(*)::int AS n FROM emails WHERE project_id = ${p2.projectId}`),
    ).toBe(0);
    expect(
      await n(
        sql`SELECT count(*)::int AS n FROM idempotency_keys WHERE project_id = ${p2.projectId}`,
      ),
    ).toBe(0);
    // Others untouched.
    expect((await v1(h, a.apiKey).get('/v1/emails')).body.data).toHaveLength(1);
    expect((await v1(h, b.apiKey).get('/v1/emails')).body.data).toHaveLength(1);
    const audit = await a.owner.get(`/api/orgs/${a.orgId}/audit`);
    expect(audit.body.some((x: { action: string }) => x.action === 'project.delete')).toBe(true);
  });

  it('cancelPending cancels waiting emails first; scheduled email is never sent afterwards', async () => {
    const p2 = await secondProject(a, 'second.test');
    await v1(h, p2.key).post(
      '/v1/emails',
      sampleEmail({
        from: 'hello@second.test',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect((await a.owner.delete(`/api/projects/${p2.projectId}?cancelPending=true`)).status).toBe(
      200,
    );
    await h.db.execute(sql`UPDATE outbox SET available_at = now() - interval '1 second'`);
    await drain(h);
    expect(h.provider.submitted).toHaveLength(0);
  });

  it('deletes a single environment and refuses to delete the last one', async () => {
    const p2 = await secondProject(a, 'second.test');
    const sbase = `/api/projects/${p2.projectId}/environments/${p2.stagingId}`;
    await a.owner.post(`${sbase}/domains`, { name: 'staging.test' });
    expect((await a.owner.delete(sbase)).status).toBe(200);
    expect((await a.owner.get(`${sbase}/domains`)).status).toBe(404);
    expect(
      (await a.owner.get(`/api/projects/${p2.projectId}/environments/${p2.envId}/domains`)).status,
    ).toBe(200);
    expect(
      (await a.owner.delete(`/api/projects/${p2.projectId}/environments/${p2.envId}`)).status,
    ).toBe(409);
  });

  it('deletes an organization without touching other organizations', async () => {
    await h.db.execute(sql`UPDATE projects SET attachment_retention_days = 30`);
    await v1(h, b.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@b.test', attachments: [attachment] }),
    );
    await v1(h, a.apiKey).post('/v1/emails', sampleEmail({ attachments: [attachment] }));
    await drain(h);
    const res = await b.owner.delete(`/api/orgs/${b.orgId}`);
    expect(res.status).toBe(200);
    expect((await b.owner.get(`/api/orgs/${b.orgId}`)).status).toBe(404);
    expect(
      await n(sql`SELECT count(*)::int AS n FROM projects WHERE organization_id = ${b.orgId}`),
    ).toBe(0);
    expect(
      await n(sql`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = ${b.orgId}`),
    ).toBe(0);
    expect(h.store.objects.size).toBe(1);
    expect((await v1(h, a.apiKey).get('/v1/emails')).body.data).toHaveLength(1);
    // The user account itself remains.
    expect((await b.owner.get('/api/me')).status).toBe(200);
  });

  it('enforces permissions and tenant boundaries', async () => {
    const inv = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'dev@acme.test',
      role: 'developer',
    });
    await h.http
      .post('/api/invitations/accept')
      .set('origin', WEB_ORIGIN)
      .send({
        token: new URL(inv.body.url).searchParams.get('token'),
        name: 'Dev',
        password: PASSWORD,
      });
    const dev = await signIn(h, 'dev@acme.test');
    expect((await dev.delete(`/api/projects/${a.projectId}`)).status).toBe(403);
    expect((await dev.delete(`/api/orgs/${a.orgId}`)).status).toBe(403);
    expect((await b.owner.delete(`/api/projects/${a.projectId}`)).status).toBe(404);
    expect((await b.owner.delete(`/api/orgs/${a.orgId}`)).status).toBe(404);
    expect((await a.owner.get(`/api/projects/${a.projectId}`)).status).toBe(200);
  });
});
