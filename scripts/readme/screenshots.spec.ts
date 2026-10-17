import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Builds the README screenshots from a fresh stack with FICTIONAL sample data
 * (agency, projects, people and domains are invented; mail only goes to local Mailpit).
 */
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'docs', 'readme', 'raw');
const API = 'http://localhost:3101';
const WEB = 'http://localhost:3100';
const PASSWORD = 'readme-demo-password-1';

const env = () =>
  JSON.parse(readFileSync(path.join(root, 'e2e', '.auth', 'stack-env.json'), 'utf8')) as Record<
    string,
    string
  >;

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: opts.fullPage ?? false });
}

test('readme screenshots', async ({ page, browser }) => {
  mkdirSync(out, { recursive: true });
  const stack = env();

  // Local webhook receiver (allow-listed for this run only).
  let hits = 0;
  const receiver = createServer((req, res) => {
    req.resume();
    hits++;
    res.writeHead(hits % 5 === 0 ? 503 : 204).end();
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const hookUrl = `http://localhost:${(receiver.address() as AddressInfo).port}/opensend/events`;

  // --- setup ---------------------------------------------------------------------------
  const cli = spawnSync(
    process.execPath,
    [path.join(root, 'apps/api/dist/cli.js'), 'bootstrap-token'],
    { env: stack, encoding: 'utf8' },
  );
  const token = `${cli.stdout}\n${cli.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l))!;
  await page.goto('/setup');
  await shot(page, 'setup');
  await page.getByLabel('Setup token').fill(token);
  await page.getByLabel('Organization name').fill('Northwind Studio');
  await page.getByLabel('Your name').fill('Mara Lindqvist');
  await page.getByLabel('Email').fill('mara@northwind.test');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  const orgId = page.url().split('/orgs/')[1]!;

  const req = page.request;
  const h = { origin: WEB };
  const post = async <T = Record<string, unknown>>(p: string, data: unknown): Promise<T> => {
    const r = await req.post(`/api${p}`, { headers: h, data });
    expect(r.ok(), `${p}: ${await r.text()}`).toBeTruthy();
    return (await r.json().catch(() => ({}))) as T;
  };
  const patch = (p: string, data: unknown) => req.patch(`/api${p}`, { headers: h, data });

  // --- projects --------------------------------------------------------------------------
  type P = { id: string; environments: Array<{ id: string; name: string }> };
  const lumen = await post<P>(`/orgs/${orgId}/projects`, {
    name: 'Lumen Tickets',
    environments: [
      { name: 'development', kind: 'development' },
      { name: 'production', kind: 'production' },
    ],
  });
  const orbit = await post<P>(`/orgs/${orgId}/projects`, {
    name: 'Orbit CRM',
    environments: [
      { name: 'development', kind: 'development' },
      { name: 'staging', kind: 'staging' },
      { name: 'production', kind: 'production' },
    ],
  });
  await post(`/orgs/${orgId}/projects`, {
    name: 'Fernhill Bakery',
    environments: [{ name: 'production', kind: 'production' }],
  });
  const dev = lumen.environments.find((e) => e.name === 'development')!.id;
  const prod = lumen.environments.find((e) => e.name === 'production')!.id;
  const base = `/projects/${lumen.id}/environments/${dev}`;
  const pbase = `/projects/${lumen.id}/environments/${prod}`;
  void orbit;

  await patch(`/projects/${lumen.id}/retention`, {
    contentDays: 14,
    attachmentDays: 7,
    eventDays: 90,
  });
  await post(`${base}/providers`, { name: 'Mailpit', type: 'local' });
  await post(`${base}/domains`, { name: 'mail.lumen.test' });
  await post(`${pbase}/providers`, {
    name: 'Amazon SES (eu-central-1)',
    type: 'ses',
    config: {
      region: 'eu-central-1',
      configurationSetName: 'lumen-events',
      snsTopicArns: ['arn:aws:sns:eu-central-1:123456789012:lumen-ses-events'],
    },
    secrets: {
      accessKeyId: 'AKIAEXAMPLEEXAMPLE00',
      secretAccessKey: 'example-secret-access-key-not-real-000000',
    },
  });
  await post(`${pbase}/domains`, { name: 'notify.lumen-tickets.dev' });

  const key = await post<{ key: string }>(`${base}/api-keys`, {
    name: 'backend (staging cluster)',
    scopes: ['emails:send', 'emails:read'],
  });
  await post(`${base}/api-keys`, {
    name: 'ci smoke tests',
    scopes: ['emails:send'],
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  await post(`${base}/api-keys`, {
    name: 'domain automation',
    scopes: ['domains:read', 'domains:manage'],
  });

  const tpl = await post<{ id: string }>(`${base}/templates`, {
    name: 'Ticket confirmation',
    slug: 'ticket-confirmation',
    subject: 'Your tickets for {{event}}',
    html: '<div style="font-family:system-ui;max-width:520px;margin:auto"><h2 style="margin:0 0 8px">Hi {{name}},</h2><p>Your <b>{{count}} tickets</b> for <b>{{event}}</b> are confirmed.</p><p style="padding:12px 16px;background:#f1f0eb;border-radius:6px">Order {{order}} · Doors open 19:00</p><p style="color:#6b6a63">See you there — the Lumen team</p></div>',
    text: 'Hi {{name}}, your {{count}} tickets for {{event}} are confirmed. Order {{order}}.',
    variables: [
      { name: 'name', required: true, sample: 'Ada' },
      { name: 'event', required: true, sample: 'Northern Lights Live' },
      { name: 'count', required: true, sample: '2' },
      { name: 'order', required: true, sample: 'LT-10421' },
    ],
  });
  await post(`${base}/templates/${tpl.id}/publish`, {});
  await post(`${base}/templates`, {
    name: 'Password reset',
    slug: 'password-reset',
    subject: 'Reset your password',
    text: 'Reset: {{url}}',
    variables: [{ name: 'url', required: true }],
  });

  const hook = await post<{ id: string }>(`${base}/webhooks`, {
    url: hookUrl,
    description: 'Lumen backend · email events',
    eventTypes: [
      'email.submitted',
      'email.failed',
      'email.delivered',
      'email.bounced',
      'email.complained',
      'email.submission_unknown',
    ],
  });
  await post(`${base}/suppressions`, {
    address: 'old-address@customer.test',
    note: 'Customer asked to stop',
  });
  await post(`${base}/suppressions`, {
    address: 'typo@gmial.test',
    note: 'Typo, hard bounce in previous system',
  });

  // --- members ----------------------------------------------------------------------------
  for (const m of [
    {
      email: 'jonas@northwind.test',
      name: 'Jonas Weber',
      role: 'developer',
      projectAccess: 'selected',
      projectIds: [lumen.id],
    },
    {
      email: 'priya@northwind.test',
      name: 'Priya Raman',
      role: 'admin',
      projectAccess: 'all',
      projectIds: [],
    },
    {
      email: 'support@lumen.test',
      name: 'Lumen Support',
      role: 'viewer',
      projectAccess: 'selected',
      projectIds: [lumen.id],
    },
  ]) {
    const inv = await post<{ url: string }>(`/orgs/${orgId}/invitations`, {
      email: m.email,
      role: m.role,
      projectAccess: m.projectAccess,
      projectIds: m.projectIds,
    });
    const t = new URL(inv.url).searchParams.get('token');
    const r = await fetch(`${API}/api/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ token: t, name: m.name, password: PASSWORD }),
    });
    expect(r.ok).toBeTruthy();
  }
  await post(`/orgs/${orgId}/invitations`, {
    email: 'freelancer@studio.test',
    role: 'developer',
    projectAccess: 'selected',
    projectIds: [lumen.id],
  });

  // --- emails through the public API --------------------------------------------------------
  const send = async (body: Record<string, unknown>, idem?: string) => {
    const r = await fetch(`${API}/v1/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
        ...(idem ? { 'idempotency-key': idem } : {}),
      },
      body: JSON.stringify({ from: 'Lumen Tickets <tickets@mail.lumen.test>', ...body }),
    });
    expect(r.status, await r.clone().text()).toBe(202);
    return (await r.json()) as { id: string };
  };
  const people = [
    'ada@guest.test',
    'linus@guest.test',
    'grace@guest.test',
    'alan@guest.test',
    'margaret@guest.test',
    'tim@guest.test',
  ];
  const events = ['Northern Lights Live', 'Jazz im Hof', 'Late Night Comedy', 'Harbour Film Night'];
  let n = 10410;
  for (const [i, to] of people.entries()) {
    await send(
      {
        to,
        template: {
          id: 'ticket-confirmation',
          variables: {
            name: to.split('@')[0]!.replace(/^./, (c) => c.toUpperCase()),
            event: events[i % events.length],
            count: String((i % 3) + 1),
            order: `LT-${n++}`,
          },
        },
        tags: { type: 'ticket', event: `ev-${(i % 4) + 1}` },
      },
      `order-${n}`,
    );
  }
  await send({
    to: ['events@venue.test'],
    cc: ['finance@venue.test', 'old-address@customer.test'],
    subject: 'Settlement report · October',
    text: 'Attached: settlement report.',
    html: '<p>Attached: settlement report.</p>',
    attachments: [
      {
        filename: 'settlement-october.csv',
        content: Buffer.from('date,tickets,amount\n2026-10-01,120,2400\n').toString('base64'),
        contentType: 'text/csv',
      },
    ],
    tags: { type: 'report' },
  });
  await send({
    to: 'old-address@customer.test',
    subject: 'We miss you',
    text: 'Come back!',
    tags: { type: 'ticket' },
  });
  await send({
    to: 'newsletter@guest.test',
    subject: 'Reminder: Northern Lights Live is tomorrow',
    text: 'See you tomorrow!',
    scheduledAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
    tags: { type: 'reminder' },
  });
  const cancelled = await send({
    to: 'linus@guest.test',
    subject: 'Reminder: Jazz im Hof',
    text: 'See you!',
    scheduledAt: new Date(Date.now() + 50 * 3_600_000).toISOString(),
    tags: { type: 'reminder' },
  });
  await fetch(`${API}/v1/emails/${cancelled.id}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key.key}` },
  });
  await send({
    to: 'grace@guest.test',
    subject: 'Reset your password',
    text: 'Use this link to reset your password.',
    tags: { type: 'auth' },
  });

  // Wait for the worker to hand everything off.
  await expect
    .poll(
      async () => {
        const o = await (await req.get(`/api${base}/overview`)).json();
        return o.pending - o.scheduled;
      },
      { timeout: 60_000 },
    )
    .toBe(0);
  await post(`${base}/webhooks/${hook.id}/test`, {});
  await page.waitForTimeout(3000);

  // --- screenshots ----------------------------------------------------------------------------
  const env0 = `/p/${lumen.id}/e/${dev}`;
  await page.goto(`/orgs/${orgId}`);
  await shot(page, 'projects');
  await page.goto(env0);
  await shot(page, 'overview');
  await page.goto(`${env0}/emails`);
  await shot(page, 'emails');

  await page
    .getByRole('link', { name: /Your tickets for Northern Lights Live/ })
    .first()
    .click();
  await expect(page.getByText('Not a delivery confirmation.')).toBeVisible();
  await shot(page, 'email-detail');
  await page
    .getByRole('heading', { name: 'Content' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -24));
  await shot(page, 'email-preview');

  await page.goto(`${env0}/domains`);
  await shot(page, 'domains');
  await page.goto(`/p/${lumen.id}/e/${prod}/domains`);
  await shot(page, 'domains-production');
  await page.goto(`/p/${lumen.id}/e/${prod}/providers`);
  await shot(page, 'providers');
  await page.goto(`${env0}/api-keys`);
  await page.getByRole('heading', { name: 'Keys', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, 'api-keys');
  await page.goto(`${env0}/templates/${tpl.id}`);
  await page.getByRole('button', { name: 'Render with sample data' }).click();
  await expect(page.getByTestId('html-preview')).toBeVisible();
  await shot(page, 'template');
  await page.goto(`${env0}/webhooks/${hook.id}`);
  await shot(page, 'webhook');
  await page.goto(`${env0}/suppressions`);
  await shot(page, 'suppressions');
  await page.goto(`/orgs/${orgId}/members`);
  await page.getByRole('heading', { name: 'Members', level: 2 }).scrollIntoViewIfNeeded();
  await shot(page, 'members');
  await page.goto(`/orgs/${orgId}/audit`);
  await shot(page, 'audit-log');
  await page.goto(`${env0}/settings`);
  await page.getByRole('heading', { name: 'Data retention' }).scrollIntoViewIfNeeded();
  await shot(page, 'settings');

  // Empty / unhappy path: a filter without matches.
  await page.goto(`${env0}/emails`);
  await page.getByLabel('Filter by recipient').fill('nobody@nowhere.test');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('No emails match these filters')).toBeVisible();
  await shot(page, 'empty');

  // Mobile.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    storageState: await page.context().storageState(),
    baseURL: WEB,
  });
  const m = await mobile.newPage();
  for (const [name, p] of [
    ['mobile-overview', env0],
    ['mobile-emails', `${env0}/emails`],
    ['mobile-domains', `${env0}/domains`],
  ] as const) {
    await m.goto(p);
    await shot(m, name);
  }
  await mobile.close();
  receiver.close();
});
