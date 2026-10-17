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

describe('cross-tenant isolation (API keys)', () => {
  it('a key cannot read, cancel or list emails of another tenant', async () => {
    const sentB = await v1(h, b.apiKey).post(
      '/v1/emails',
      sampleEmail({
        from: 'hello@b.test',
        attachments: [{ filename: 'x.txt', content: Buffer.from('secret').toString('base64') }],
      }),
    );
    expect(sentB.status).toBe(202);
    const id = sentB.body.id;

    expect((await v1(h, a.apiKey).get(`/v1/emails/${id}`)).status).toBe(404);
    expect((await v1(h, a.apiKey).post(`/v1/emails/${id}/cancel`)).status).toBe(404);
    const list = await v1(h, a.apiKey).get('/v1/emails');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);
    // Search by recipient across tenants reveals nothing.
    const search = await v1(h, a.apiKey).get('/v1/emails?recipient=alice@example.test');
    expect(search.body.data).toHaveLength(0);
    // Usage / statistics only count own project.
    const usageA = await v1(h, a.apiKey).get('/v1/usage');
    expect(usageA.body.acceptedRecipients).toBe(0);
  });

  it("a tenant cannot send from another tenant's domain", async () => {
    const r = await v1(h, a.apiKey).post('/v1/emails', sampleEmail({ from: 'hello@b.test' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('domain_not_verified');
  });
});

describe('cross-tenant isolation (sessions)', () => {
  it("a user cannot access another organization's projects, emails, exports or audit log", async () => {
    const sentB = await v1(h, b.apiKey).post('/v1/emails', sampleEmail({ from: 'hello@b.test' }));
    const base = `/api/projects/${b.projectId}/environments/${b.envId}`;
    for (const path of [
      `/api/projects/${b.projectId}`,
      `${base}/overview`,
      `${base}/emails`,
      `${base}/emails/${sentB.body.id}`,
      `${base}/emails/${sentB.body.id}/content`,
      `${base}/export`,
      `${base}/api-keys`,
      `${base}/providers`,
      `${base}/domains`,
      `${base}/webhooks`,
      `${base}/suppressions`,
      `/api/projects/${b.projectId}/usage`,
    ]) {
      const r = await a.owner.get(path);
      expect(r.status, path).toBe(404);
    }
    expect((await a.owner.get(`/api/orgs/${b.orgId}`)).status).toBe(404);
    expect((await a.owner.get(`/api/orgs/${b.orgId}/audit`)).status).toBe(404);
    expect((await a.owner.get(`/api/orgs/${b.orgId}/members`)).status).toBe(404);
    // Mixing own project id with a foreign environment id is rejected too.
    expect(
      (await a.owner.get(`/api/projects/${a.projectId}/environments/${b.envId}/emails`)).status,
    ).toBe(404);
    expect(
      (
        await a.owner.post(`/api/projects/${a.projectId}/environments/${b.envId}/api-keys`, {
          name: 'x',
          scopes: ['emails:send'],
        })
      ).status,
    ).toBe(404);
  });

  it('members restricted to selected projects see neither data nor aggregates of other projects', async () => {
    const p2 = await a.owner.post(`/api/orgs/${a.orgId}/projects`, { name: 'Other client' });
    const env2 = p2.body.environments[0].id;
    await a.owner.post(`/api/projects/${p2.body.id}/environments/${env2}/providers`, {
      name: 'L',
      type: 'local',
    });
    await a.owner.post(`/api/projects/${p2.body.id}/environments/${env2}/domains`, {
      name: 'other.test',
    });

    const inv = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'dev@a.test',
      role: 'developer',
      projectAccess: 'selected',
      projectIds: [a.projectId],
    });
    expect(inv.status).toBe(201);
    const token = new URL(inv.body.url).searchParams.get('token');
    expect(
      (
        await h.http
          .post('/api/invitations/accept')
          .set('origin', WEB_ORIGIN)
          .send({ token, name: 'Dev', password: PASSWORD })
      ).status,
    ).toBe(201);
    const dev = await signIn(h, 'dev@a.test');

    const org = await dev.get(`/api/orgs/${a.orgId}`);
    expect(org.body.projects.map((p: { id: string }) => p.id)).toEqual([a.projectId]);
    expect((await dev.get(`/api/projects/${p2.body.id}`)).status).toBe(404);
    expect(
      (await dev.get(`/api/projects/${p2.body.id}/environments/${env2}/overview`)).status,
    ).toBe(404);
    expect((await dev.get(`/api/projects/${p2.body.id}/usage`)).status).toBe(404);
    expect(
      (await dev.get(`/api/projects/${a.projectId}/environments/${a.envId}/emails`)).status,
    ).toBe(200);
    // A developer cannot read the audit log at all.
    expect((await dev.get(`/api/orgs/${a.orgId}/audit?projectId=${p2.body.id}`)).status).toBe(403);
  });

  it('roles are enforced and invitations cannot escalate privileges', async () => {
    const inviteViewer = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'viewer@a.test',
      role: 'viewer',
    });
    const token = new URL(inviteViewer.body.url).searchParams.get('token');
    await h.http
      .post('/api/invitations/accept')
      .set('origin', WEB_ORIGIN)
      .send({ token, name: 'Viewer', password: PASSWORD });
    const viewer = await signIn(h, 'viewer@a.test');
    const base = `/api/projects/${a.projectId}/environments/${a.envId}`;
    const sent = await v1(h, a.apiKey).post('/v1/emails', sampleEmail());

    expect((await viewer.get(`${base}/emails/${sent.body.id}`)).status).toBe(200);
    expect((await viewer.get(`${base}/emails/${sent.body.id}/content`)).status).toBe(403);
    expect(
      (await viewer.post(`${base}/api-keys`, { name: 'x', scopes: ['emails:send'] })).status,
    ).toBe(403);
    expect((await viewer.post(`${base}/emails/${sent.body.id}/cancel`)).status).toBe(403);
    expect(
      (await viewer.post(`/api/orgs/${a.orgId}/invitations`, { email: 'x@a.test', role: 'viewer' }))
        .status,
    ).toBe(403);

    // An admin cannot mint owners; an invitation keeps the role fixed at creation.
    const inviteAdmin = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'admin@a.test',
      role: 'admin',
    });
    await h.http
      .post('/api/invitations/accept')
      .set('origin', WEB_ORIGIN)
      .send({
        token: new URL(inviteAdmin.body.url).searchParams.get('token'),
        name: 'Admin',
        password: PASSWORD,
      });
    const admin = await signIn(h, 'admin@a.test');
    expect(
      (
        await admin.post(`/api/orgs/${a.orgId}/invitations`, {
          email: 'boss@a.test',
          role: 'owner',
        })
      ).status,
    ).toBe(403);
    const members = await admin.get(`/api/orgs/${a.orgId}/members`);
    const ownerMember = members.body.find((m: { role: string }) => m.role === 'owner');
    expect(
      (await admin.patch(`/api/orgs/${a.orgId}/members/${ownerMember.id}`, { role: 'viewer' }))
        .status,
    ).toBe(403);
    const self = members.body.find((m: { email: string }) => m.email === 'admin@a.test');
    expect(
      (await admin.patch(`/api/orgs/${a.orgId}/members/${self.id}`, { role: 'owner' })).status,
    ).toBe(403);
  });

  it('invitations are single-use, expire and can be revoked', async () => {
    const inv = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'x@a.test',
      role: 'developer',
    });
    const token = new URL(inv.body.url).searchParams.get('token');
    await h.db.execute(sql`UPDATE invitations SET expires_at = now() - interval '1 minute'`);
    expect(
      (
        await h.http
          .post('/api/invitations/accept')
          .set('origin', WEB_ORIGIN)
          .send({ token, name: 'X', password: PASSWORD })
      ).status,
    ).toBe(404);

    const inv2 = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'y@a.test',
      role: 'developer',
    });
    const token2 = new URL(inv2.body.url).searchParams.get('token');
    expect((await a.owner.delete(`/api/orgs/${a.orgId}/invitations/${inv2.body.id}`)).status).toBe(
      204,
    );
    expect((await h.http.get(`/api/invitations/lookup?token=${token2}`)).status).toBe(404);

    const inv3 = await a.owner.post(`/api/orgs/${a.orgId}/invitations`, {
      email: 'z@a.test',
      role: 'developer',
    });
    const token3 = new URL(inv3.body.url).searchParams.get('token');
    expect(
      (
        await h.http
          .post('/api/invitations/accept')
          .set('origin', WEB_ORIGIN)
          .send({ token: token3, name: 'Z', password: PASSWORD })
      ).status,
    ).toBe(201);
    expect(
      (
        await h.http
          .post('/api/invitations/accept')
          .set('origin', WEB_ORIGIN)
          .send({ token: token3, name: 'Z', password: PASSWORD })
      ).status,
    ).toBe(404);
  });

  it('attachments of another project cannot be downloaded', async () => {
    const sentB = await v1(h, b.apiKey).post(
      '/v1/emails',
      sampleEmail({
        from: 'hello@b.test',
        attachments: [{ filename: 'x.txt', content: Buffer.from('secret').toString('base64') }],
      }),
    );
    const detail = await b.owner.get(
      `/api/projects/${b.projectId}/environments/${b.envId}/emails/${sentB.body.id}`,
    );
    const attId = detail.body.attachments[0].id;
    expect(
      (
        await b.owner.get(
          `/api/projects/${b.projectId}/environments/${b.envId}/emails/${sentB.body.id}/attachments/${attId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await a.owner.get(
          `/api/projects/${b.projectId}/environments/${b.envId}/emails/${sentB.body.id}/attachments/${attId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await a.owner.get(
          `/api/projects/${a.projectId}/environments/${a.envId}/emails/${sentB.body.id}/attachments/${attId}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('API key lifecycle and scopes', () => {
  it('revoked and expired keys are rejected; scopes are enforced', async () => {
    const base = `/api/projects/${a.projectId}/environments/${a.envId}`;
    const k = await a.owner.post(`${base}/api-keys`, {
      name: 'send-only',
      scopes: ['emails:send'],
    });
    expect(k.body.key).toMatch(/^os_/);
    const list = await a.owner.get(`${base}/api-keys`);
    expect(JSON.stringify(list.body)).not.toContain(k.body.key.split('_')[2]);

    expect((await v1(h, k.body.key).post('/v1/emails', sampleEmail())).status).toBe(202);
    const read = await v1(h, k.body.key).get('/v1/emails');
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('insufficient_scope');
    expect((await v1(h, k.body.key).post('/v1/domains', { name: 'x.test' })).status).toBe(403);
    expect((await v1(h, k.body.key).get('/v1/usage')).status).toBe(403);

    await a.owner.delete(`${base}/api-keys/${k.body.id}`);
    const revoked = await v1(h, k.body.key).post('/v1/emails', sampleEmail());
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('invalid_api_key');

    const k2 = await a.owner.post(`${base}/api-keys`, {
      name: 'short',
      scopes: ['emails:send'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.db.execute(
      sql`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = ${k2.body.id}`,
    );
    expect((await v1(h, k2.body.key).post('/v1/emails', sampleEmail())).status).toBe(401);

    // Tampered secret with a valid prefix.
    const tampered = `${k2.body.key.slice(0, -4)}AAAA`;
    expect((await v1(h, tampered).post('/v1/emails', sampleEmail())).status).toBe(401);
    expect((await h.http.post('/v1/emails').send(sampleEmail())).status).toBe(401);
  });
});

describe('dashboard authentication and CSRF', () => {
  it('requires a session and rejects cross-site writes', async () => {
    expect((await h.http.get('/api/me')).status).toBe(401);
    // Cookie-authenticated write from another origin is rejected before reaching handlers.
    const evil = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/projects`)
      .set('origin', 'https://evil.example')
      .send({ name: 'x' });
    expect(evil.status).toBe(403);
    const noOrigin = await a.owner.agent.post(`/api/orgs/${a.orgId}/projects`).send({ name: 'x' });
    expect(noOrigin.status).toBe(403);
  });

  it('public sign-up is disabled and setup cannot be repeated', async () => {
    const signUp = await h.http
      .post('/api/auth/sign-up/email')
      .set('origin', WEB_ORIGIN)
      .send({ email: 'new@x.test', password: PASSWORD, name: 'N' });
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    const users = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "user" WHERE email = 'new@x.test'`,
    );
    expect(users.rows[0]!.n).toBe(0);
    const again = await h.http
      .post('/api/setup')
      .set('origin', WEB_ORIGIN)
      .send({
        token: 'x'.repeat(43),
        organizationName: 'XY',
        name: 'X',
        email: 'x@x.test',
        password: PASSWORD,
      });
    expect([403, 409]).toContain(again.status);
  });

  it('the dashboard drains nothing it should not: processing keeps tenants separate', async () => {
    await v1(h, a.apiKey).post('/v1/emails', sampleEmail());
    await v1(h, b.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@b.test', to: ['bob@example.test'] }),
    );
    await drain(h);
    const aList = await v1(h, a.apiKey).get('/v1/emails');
    const bList = await v1(h, b.apiKey).get('/v1/emails');
    expect(aList.body.data).toHaveLength(1);
    expect(bList.body.data).toHaveLength(1);
    expect(aList.body.data[0].from).toBe('Acme <hello@acme.test>');
  });
});
