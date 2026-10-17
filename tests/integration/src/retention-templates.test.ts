import { sql } from '@opensend/db';
import { runRetention } from '@opensend/worker';
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
  h = await startHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h);
});
const attachment = {
  filename: 'invoice.txt',
  content: Buffer.from('invoice #1').toString('base64'),
  contentType: 'text/plain',
};

describe('retention', () => {
  it('purges content and attachments per project policy without touching other projects', async () => {
    // Second project in the same organization keeps content for 30 days.
    const p2 = await t.owner.post(`/api/orgs/${t.orgId}/projects`, { name: 'Archive' });
    const e2 = p2.body.environments[0].id;
    const b2 = `/api/projects/${p2.body.id}/environments/${e2}`;
    await t.owner.post(`${b2}/providers`, { name: 'L', type: 'local' });
    await t.owner.post(`${b2}/domains`, { name: 'archive.test' });
    const key2 = (
      await t.owner.post(`${b2}/api-keys`, { name: 'k', scopes: ['emails:send', 'emails:read'] })
    ).body.key;
    expect(
      (
        await t.owner.patch(`/api/projects/${p2.body.id}/retention`, {
          contentDays: 30,
          attachmentDays: 30,
          eventDays: 365,
        })
      ).status,
    ).toBe(200);

    const r1 = await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ attachments: [attachment] }));
    const r2 = await v1(h, key2).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@archive.test', attachments: [attachment] }),
    );
    expect(h.store.objects.size).toBe(2);
    await drain(h);

    // Project 1 (default: no long-term content archive): purged right after hand-off.
    const e1 = (await v1(h, t.apiKey).get(`/v1/emails/${r1.body.id}`)).body;
    expect(e1.contentPurged).toBe(true);
    expect(e1.subject).toBeNull();
    const c1 = await t.owner.get(
      `/api/projects/${t.projectId}/environments/${t.envId}/emails/${r1.body.id}/content`,
    );
    expect(c1.body.purged).toBe(true);
    expect(c1.body.html).toBeNull();
    // Project 2 keeps it.
    const c2 = await t.owner.get(`${b2}/emails/${r2.body.id}/content`);
    expect(c2.body).toMatchObject({ purged: false, html: '<p>Hi</p>' });
    const stored = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM email_contents`,
    );
    expect(stored.rows[0]!.n).toBe(1);
    expect(h.store.objects.size).toBe(1);

    // Event retention: project 1 metadata expires, project 2 is untouched.
    await h.db.execute(sql`UPDATE projects SET event_retention_days = 1 WHERE id = ${t.projectId}`);
    await h.db.execute(sql`UPDATE emails SET accepted_at = now() - interval '10 days'`);
    const report = await runRetention(h.deps);
    expect(report.emailsDeleted).toBe(1);
    expect((await v1(h, t.apiKey).get(`/v1/emails/${r1.body.id}`)).status).toBe(404);
    expect((await v1(h, key2).get(`/v1/emails/${r2.body.id}`)).status).toBe(200);
    expect(h.store.objects.size).toBe(1);

    // Content of project 2 is purged once its own 30 days have passed.
    await h.db.execute(sql`UPDATE emails SET finalized_at = now() - interval '31 days'`);
    await runRetention(h.deps);
    expect((await t.owner.get(`${b2}/emails/${r2.body.id}/content`)).body.purged).toBe(true);
    expect(h.store.objects.size).toBe(0);
  });

  it('keeps content of unclear submissions for manual resolution', async () => {
    h.provider.next({ outcome: 'unknown', category: 'timeout', code: 'etimedout', message: 't' });
    const r = await v1(h, t.apiKey).post('/v1/emails', sampleEmail());
    await drain(h);
    await runRetention(h.deps);
    expect((await v1(h, t.apiKey).get(`/v1/emails/${r.body.id}`)).body.contentPurged).toBe(false);
  });

  it('exports only the requested environment, without message content', async () => {
    const other = await createTenant(h, { domain: 'other.test' });
    await v1(h, other.apiKey).post(
      '/v1/emails',
      sampleEmail({ from: 'hello@other.test', subject: 'other tenant' }),
    );
    await v1(h, t.apiKey).post('/v1/emails', sampleEmail({ subject: 'mine' }));
    const res = await t.owner
      .get(`/api/projects/${t.projectId}/environments/${t.envId}/export`)
      .buffer(true)
      .parse((r, cb) => {
        let d = '';
        r.on('data', (c: Buffer) => (d += c.toString()));
        r.on('end', () => cb(null, d));
      });
    expect(res.status).toBe(200);
    const lines = (res.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0].type).toBe('export');
    const emails = lines.filter((l) => l.type === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('mine');
    expect(res.body).not.toContain('<p>Hi</p>');
  });
});

describe('templates', () => {
  const tbase = () => `/api/projects/${t.projectId}/environments/${t.envId}/templates`;

  it('accepted emails are bound to the published version and unaffected by later edits', async () => {
    const tpl = await t.owner.post(tbase(), {
      name: 'Welcome',
      slug: 'welcome',
      subject: 'Welcome {{name}}',
      html: '<h1>Hello {{name}}</h1><p>v1</p>',
      text: 'Hello {{name}} v1',
      variables: [{ name: 'name', required: true, sample: 'Ada' }],
    });
    expect(tpl.status).toBe(201);
    // Not published yet.
    expect(
      (
        await v1(h, t.apiKey).post('/v1/emails', {
          from: 'hello@acme.test',
          to: 'x@example.test',
          template: { id: 'welcome', variables: { name: 'Bob' } },
        })
      ).status,
    ).toBe(422);
    expect((await t.owner.post(`${tbase()}/${tpl.body.id}/publish`)).body.version).toBe(1);

    const scheduled = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'hello@acme.test',
      to: 'x@example.test',
      template: { id: 'welcome', variables: { name: '<script>alert(1)</script>' } },
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.status).toBe(202);

    // Edit + publish v2 while v1 email is still scheduled.
    await t.owner.patch(`${tbase()}/${tpl.body.id}`, {
      html: '<h1>Hi {{name}}</h1><p>v2</p>',
      subject: 'v2 {{name}}',
    });
    expect((await t.owner.post(`${tbase()}/${tpl.body.id}/publish`)).body.version).toBe(2);
    const latest = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'hello@acme.test',
      to: 'y@example.test',
      template: { id: 'welcome', variables: { name: 'Cy' } },
    });
    const pinned = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'hello@acme.test',
      to: 'z@example.test',
      template: { id: 'welcome', version: 1, variables: { name: 'Di' } },
    });

    await h.db.execute(sql`UPDATE emails SET scheduled_at = now() - interval '1 second'`);
    await h.db.execute(sql`UPDATE outbox SET available_at = now() - interval '1 second'`);
    await drain(h);
    const byTo = Object.fromEntries(h.provider.submitted.map((m) => [m.to[0], m]));
    expect(byTo['x@example.test']!.html).toContain('v1');
    expect(byTo['x@example.test']!.html).toContain('&lt;script&gt;');
    expect(byTo['x@example.test']!.subject).toBe('Welcome <script>alert(1)</script>');
    expect(byTo['y@example.test']!.html).toContain('v2');
    expect(byTo['z@example.test']!.html).toContain('v1');
    const detail = await t.owner.get(
      `/api/projects/${t.projectId}/environments/${t.envId}/emails/${scheduled.body.id}`,
    );
    expect(detail.body.templateVersionId).not.toBeNull();
    void latest;
    void pinned;
  });

  it('validates variables and template syntax', async () => {
    const bad = await t.owner.post(tbase(), {
      name: 'x',
      slug: 'x',
      subject: 'Hi {{undeclared}}',
      text: 't',
      variables: [],
    });
    expect(bad.status).toBe(422);
    const raw = await t.owner.post(tbase(), {
      name: 'y',
      slug: 'y',
      subject: 'Hi',
      html: '{{{name}}}',
      variables: [{ name: 'name' }],
    });
    expect(raw.status).toBe(422);
    const ok = await t.owner.post(tbase(), {
      name: 'z',
      slug: 'z',
      subject: 'Hi {{name}}',
      text: 'x {{plan}}',
      variables: [{ name: 'name' }, { name: 'plan', required: false, fallback: 'free' }],
    });
    await t.owner.post(`${tbase()}/${ok.body.id}/publish`);
    const missing = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'hello@acme.test',
      to: 'x@example.test',
      template: { id: 'z', variables: {} },
    });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.variables).toEqual(['name']);
    const unknown = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'hello@acme.test',
      to: 'x@example.test',
      template: { id: 'z', variables: { name: 'a', extra: 'b' } },
    });
    expect(unknown.status).toBe(422);
    const preview = await t.owner.post(`${tbase()}/${ok.body.id}/preview`, {});
    expect(preview.body.text).toBe('x free');
  });

  it('templates are scoped to the environment', async () => {
    const other = await createTenant(h, { domain: 'other.test' });
    const tpl = await other.owner.post(
      `/api/projects/${other.projectId}/environments/${other.envId}/templates`,
      { name: 'Theirs', slug: 'theirs', subject: 's', text: 't' },
    );
    await other.owner.post(
      `/api/projects/${other.projectId}/environments/${other.envId}/templates/${tpl.body.id}/publish`,
    );
    const r = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'hello@acme.test',
      to: 'x@example.test',
      template: { id: tpl.body.id },
    });
    expect(r.status).toBe(422);
  });
});
