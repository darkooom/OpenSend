import { sql } from '@opensend/db';
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

let h: Harness;
let t: Tenant;
beforeAll(async () => {
  h = await startHarness({
    config: {
      OPENSEND_MAX_PENDING_PER_ENVIRONMENT: '25',
      OPENSEND_MAX_RECIPIENTS: '5',
      OPENSEND_MAX_ATTACHMENT_BYTES: '1000',
    },
  });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h);
});
const base = () => `/api/projects/${t.projectId}/environments/${t.envId}`;
const usage = async () => (await v1(h, t.apiKey).get('/v1/usage')).body;

describe('suppressions', () => {
  it('suppressed recipients are never handed to the provider', async () => {
    await t.owner.post(`${base()}/suppressions`, { address: 'Blocked@Example.test' });
    const only = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ to: ['blocked@example.test'] }),
    );
    expect(only.body.status).toBe('suppressed');
    const mixed = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ to: ['blocked@example.test', 'ok@example.test'] }),
    );
    expect(mixed.body.status).toBe('queued');
    await drain(h);
    expect(h.provider.submitted).toHaveLength(1);
    expect(h.provider.submitted[0]!.to).toEqual(['ok@example.test']);
    // All accepted recipients consume quota because every accepted request creates durable data.
    expect((await usage()).acceptedRecipients).toBe(3);
  });

  it('suppressions added after acceptance are enforced before hand-off', async () => {
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ to: ['late@example.test'] }));
    await t.owner.post(`${base()}/suppressions`, { address: 'late@example.test' });
    await drain(h);
    expect(h.provider.submitted).toHaveLength(0);
    expect((await v1(h, t.apiKey).get(`/v1/emails/${r.body.id}`)).body.status).toBe('suppressed');
  });

  it('platform blocks apply without revealing their origin', async () => {
    await h.db.execute(
      sql`INSERT INTO platform_suppressions (address, reason) VALUES ('abuse@example.test', 'reported by another tenant')`,
    );
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ to: ['abuse@example.test'] }));
    const e = (await v1(h, t.apiKey).get(`/v1/emails/${r.body.id}`)).body;
    expect(e.recipients[0].status).toBe('suppressed');
    expect(e.recipients[0].statusDetail).toBe('policy');
    expect(JSON.stringify(e)).not.toContain('another tenant');
    // The tenant suppression list does not contain platform entries.
    const list = await t.owner.get(`${base()}/suppressions`);
    expect(list.body).toHaveLength(0);
  });
});

describe('quotas, limits and backlog', () => {
  it('rejects over-quota requests atomically, without leftover reservations', async () => {
    await h.db.execute(sql`UPDATE projects SET monthly_recipient_quota = 3`);
    expect(
      (await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ to: ['a@x.test', 'b@x.test'] })))
        .status,
    ).toBe(202);
    const over = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ to: ['c@x.test', 'd@x.test'] }),
    );
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('quota_exceeded');
    expect((await usage()).acceptedRecipients).toBe(2);
    expect(
      (await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ to: ['c@x.test'] }))).status,
    ).toBe(202);
    expect((await usage()).acceptedRecipients).toBe(3);
  });

  it('parallel requests cannot exceed the quota', async () => {
    await h.db.execute(sql`UPDATE projects SET monthly_recipient_quota = 5`);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        v1(h, t.apiKey).post('/v1/emails', sampleEmail({ to: [`p${i}@x.test`] })),
      ),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    const u = await usage();
    expect(u.acceptedRecipients).toBe(5);
    const emails = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM emails`);
    expect(emails.rows[0]!.n).toBe(5);
  });

  it('enforces the pending backlog per environment', async () => {
    const results = [];
    for (let i = 0; i < 26; i++)
      results.push(
        (await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ to: [`q${i}@x.test`] }))).status,
      );
    expect(results.filter((s) => s === 202)).toHaveLength(25);
    expect(results[25]).toBe(429);
    await drain(h, 5);
    expect((await v1(h, t.apiKey).post('/v1/emails', sampleEmail())).status).toBe(202);
  });

  it('validates recipients, sizes and headers early', async () => {
    const tooMany = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ to: ['1@x.test', '2@x.test', '3@x.test', '4@x.test', '5@x.test', '6@x.test'] }),
    );
    expect(tooMany.status).toBe(422);
    const big = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({
        attachments: [{ filename: 'a.bin', content: Buffer.alloc(2000).toString('base64') }],
      }),
    );
    expect(big.status).toBe(413);
    const badB64 = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ attachments: [{ filename: 'a.bin', content: 'not base64!!' }] }),
    );
    expect(badB64.status).toBe(422);
    const injection = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ subject: 'Hi\r\nBcc: victim@x.test' }),
    );
    expect(injection.status).toBe(422);
    const internalHeader = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ headers: { 'X-OpenSend-Email-Id': 'spoof' } }),
    );
    expect(internalHeader.status).toBe(422);
    const fromHeader = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ headers: { From: 'ceo@bank.example' } }),
    );
    expect(fromHeader.status).toBe(422);
    const urlAttachment = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ attachments: [{ filename: 'a', path: 'http://169.254.169.254/' }] }),
    );
    expect(urlAttachment.status).toBe(422);
    const ok = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ headers: { 'X-Campaign': 'spring' } }),
    );
    expect(ok.status).toBe(202);
    await drain(h);
    expect(h.provider.submitted[0]!.headers['X-Campaign']).toBe('spring');
    expect(h.provider.submitted[0]!.headers['X-OpenSend-Email-Id']).toBe(ok.body.id);
  });

  it('a paused project accepts nothing and holds pending work', async () => {
    const pending = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    const admin = t.owner; // the first tenant owner is the platform operator
    expect(
      (
        await admin.post(`/api/admin/projects/${t.projectId}/pause`, {
          reason: 'abuse investigation',
        })
      ).status,
    ).toBe(200);
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    expect(r.status).toBe(423);
    await drain(h);
    expect(h.provider.submitted).toHaveLength(0);
    expect((await v1(h, t.apiKey).get(`/v1/emails/${pending.body.id}`)).body.status).toBe('queued');
    const overview = await t.owner.get(`${base()}/overview`);
    expect(
      overview.body.warnings.some((w: { message: string }) => w.message.includes('paused')),
    ).toBe(true);
    await admin.post(`/api/admin/projects/${t.projectId}/resume`);
    await h.db.execute(
      sql`UPDATE outbox SET available_at = now() - interval '1 second', dispatched_at = NULL WHERE completed_at IS NULL`,
    );
    await drain(h);
    expect(h.provider.submitted).toHaveLength(1);
    const audit = await t.owner.get(`/api/orgs/${t.orgId}/audit`);
    expect(audit.body.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['project.pause', 'project.resume']),
    );
  });
});

describe('domain authorization', () => {
  it('requires a registered domain in the same environment', async () => {
    const r = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@not-registered.test' }),
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('domain_not_verified');
  });

  it('production: ownership proof and provider verification are required; local-only domains are refused', async () => {
    const prod = await createTenant(h, { envKind: 'production', domain: 'brand-mail.io' });
    const pbase = `/api/projects/${prod.projectId}/environments/${prod.envId}`;
    const send = () =>
      v1(h, prod.apiKey).post('/v1/emails', sampleEmail({ from: 'hello@brand-mail.io' }));
    expect((await send()).status).toBe(422);

    const [domain] = (await prod.owner.get(`${pbase}/domains`)).body;
    expect(domain.ownership.record.name).toBe('_opensend.brand-mail.io');
    // Wrong TXT value: still pending.
    h.dns.txt.set('_opensend.brand-mail.io', ['opensend-verification=wrong']);
    h.provider.domainSetup = {
      status: 'pending',
      records: [
        {
          purpose: 'dkim',
          type: 'CNAME',
          name: 'tok._domainkey.brand-mail.io',
          value: 'tok.dkim.amazonses.com',
          required: true,
          status: 'unknown',
          found: [],
        },
      ],
    };
    let v = (await prod.owner.post(`${pbase}/domains/${domain.id}/verify`)).body;
    expect(v.ownership.status).toBe('pending');
    expect(v.ownership.lastError).toMatch(/none matches/);
    expect(v.provider.status).toBe('not_started'); // provider identity is only created after ownership proof
    // Correct TXT: ownership verified, provider still pending -> cannot send.
    h.dns.txt.set('_opensend.brand-mail.io', [domain.ownership.record.value]);
    h.dns.txt.set('brand-mail.io', ['v=spf1 include:_spf.example.net ~all', 'v=spf1 -all']);
    v = (await prod.owner.post(`${pbase}/domains/${domain.id}/verify`)).body;
    expect(v.ownership.status).toBe('verified');
    expect(v.provider.status).toBe('pending');
    expect(v.provider.records[0]).toMatchObject({ type: 'CNAME', status: 'missing' });
    expect(v.diagnostics.spf.status).toBe('error'); // two SPF records -> we never suggest a third
    expect(v.canSend).toBe(false);
    expect((await send()).status).toBe(422);
    // Provider verified -> can send.
    h.provider.domainSetup = { status: 'verified', records: [] };
    v = (await prod.owner.post(`${pbase}/domains/${domain.id}/verify`)).body;
    expect(v.canSend).toBe(true);
    expect((await send()).status).toBe(202);

    const local = await prod.owner.post(`${pbase}/domains`, { name: 'app.test' });
    expect(local.status).toBe(422);
    const localProvider = await prod.owner.post(`${pbase}/providers`, {
      name: 'Mailpit',
      type: 'local',
    });
    expect(localProvider.status).toBe(422);
  });

  it('adding a domain in another project neither takes over nor reveals the existing one', async () => {
    const other = await createTenant(h, { domain: 'acme.test' });
    // Both projects have their own row and token; nothing tells tenant B that A uses it.
    const aDomains = (await t.owner.get(`${base()}/domains`)).body;
    const bDomains = (
      await other.owner.get(`/api/projects/${other.projectId}/environments/${other.envId}/domains`)
    ).body;
    expect(aDomains[0].id).not.toBe(bDomains[0].id);
    expect(aDomains[0].ownership.record.value).not.toBe(bDomains[0].ownership.record.value);
  });
});
