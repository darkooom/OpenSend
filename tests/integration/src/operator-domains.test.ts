import { sql } from '@opensend/db';
import { recheckDomainOwnership } from '@opensend/worker';
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
let op: Tenant;
let prod: Tenant;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  op = await createTenant(h); // first tenant owner = platform operator
  prod = await createTenant(h, { envKind: 'production', domain: 'brand-mail.io' });
});

async function verifyProdDomain() {
  const base = `/api/projects/${prod.projectId}/environments/${prod.envId}`;
  const [d] = (await prod.owner.get(`${base}/domains`)).body;
  h.dns.txt.set(d.ownership.record.name, [d.ownership.record.value]);
  h.provider.domainSetup = { status: 'verified', records: [] };
  expect((await prod.owner.post(`${base}/domains/${d.id}/verify`)).body.canSend).toBe(true);
  return {
    base,
    domain: d as { id: string; ownership: { record: { name: string; value: string } } },
  };
}

describe('operator controls', () => {
  it('lists connections and pausing one holds its emails', async () => {
    const list = await op.owner.get('/api/admin/connections');
    expect(list.status).toBe(200);
    const conn = list.body.find(
      (c: { project: string; organization: string }) => c.organization !== 'Agency',
    );
    expect(conn).toBeTruthy();
    expect((await prod.owner.get('/api/admin/connections')).status).toBe(403);

    const { domain } = await verifyProdDomain();
    void domain;
    expect(
      (await op.owner.post(`/api/admin/connections/${conn.id}/pause`, { reason: 'abuse report' }))
        .status,
    ).toBe(200);
    const rejected = await v1(h, prod.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@brand-mail.io' }),
    );
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('provider_unavailable');
    expect((await op.owner.post(`/api/admin/connections/${conn.id}/resume`)).status).toBe(200);
    expect(
      (await v1(h, prod.apiKey).post('/v1/emails', sampleEmail({ from: 'hello@brand-mail.io' })))
        .status,
    ).toBe(202);
  });

  it('manages the platform block list', async () => {
    expect(
      (
        await op.owner.post('/api/admin/suppressions', {
          address: 'blocked@example.test',
          reason: 'spam trap',
        })
      ).status,
    ).toBe(201);
    const list = await op.owner.get('/api/admin/suppressions');
    expect(list.body).toHaveLength(1);
    expect(
      (
        await prod.owner.post('/api/admin/suppressions', {
          address: 'x@example.test',
          reason: 'nope',
        })
      ).status,
    ).toBe(403);
    expect((await op.owner.delete(`/api/admin/suppressions/${list.body[0].id}`)).status).toBe(204);
  });
});

describe('periodic domain ownership re-check', () => {
  it('flags a missing TXT record, revokes ownership after the grace period, restores on re-verify', async () => {
    const { base, domain } = await verifyProdDomain();
    const resolver = { resolveTxt: async (name: string) => h.dns.txt.get(name) ?? [] };

    // Record still there: nothing changes.
    expect(await recheckDomainOwnership(h.deps, { resolver, olderThanHours: 0 })).toMatchObject({
      checked: 1,
      missing: 0,
    });

    // Record removed: flagged, still allowed to send during the grace period.
    h.dns.txt.delete(domain.ownership.record.name);
    expect(await recheckDomainOwnership(h.deps, { resolver, olderThanHours: 0 })).toMatchObject({
      missing: 1,
      revoked: 0,
    });
    let d = (await prod.owner.get(`${base}/domains`)).body[0];
    expect(d.ownership.missingSince).not.toBeNull();
    expect(d.canSend).toBe(true);
    const overview = await prod.owner.get(`${base}/overview`);
    expect(
      overview.body.warnings.some((w: { message: string }) =>
        w.message.includes('ownership TXT record missing'),
      ),
    ).toBe(true);

    // DNS failures do not count as missing.
    const failing = {
      resolveTxt: async () =>
        Promise.reject(Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' })),
    };
    expect(
      await recheckDomainOwnership(h.deps, { resolver: failing, olderThanHours: 0 }),
    ).toMatchObject({ checked: 0 });

    // Grace period over: ownership revoked, sending refused, audit entry written.
    await h.db.execute(
      sql`UPDATE domains SET ownership_missing_since = now() - interval '73 hours'`,
    );
    expect(await recheckDomainOwnership(h.deps, { resolver, olderThanHours: 0 })).toMatchObject({
      revoked: 1,
    });
    d = (await prod.owner.get(`${base}/domains`)).body[0];
    expect(d.ownership.status).toBe('pending');
    expect(d.canSend).toBe(false);
    expect(
      (await v1(h, prod.apiKey).post('/v1/emails', sampleEmail({ from: 'hello@brand-mail.io' })))
        .status,
    ).toBe(422);
    const audit = await prod.owner.get(`/api/orgs/${prod.orgId}/audit`);
    expect(
      audit.body.some((a: { action: string }) => a.action === 'domain.ownership_revoked'),
    ).toBe(true);

    // Publishing the record again and verifying restores it.
    h.dns.txt.set(domain.ownership.record.name, [domain.ownership.record.value]);
    expect((await prod.owner.post(`${base}/domains/${domain.id}/verify`)).body.canSend).toBe(true);
    await drain(h);
  });
});
