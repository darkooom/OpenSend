import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IT } from './env';
import {
  PASSWORD,
  WEB_ORIGIN,
  createTenant,
  resetDatabase,
  resetTenants,
  signIn,
  startHarness,
  type Harness,
  type Tenant,
} from './harness';

/** Account emails through the operator-configured platform sender (real SMTP into Mailpit). */
let h: Harness;
let t: Tenant;
const run = randomBytes(3).toString('hex');
const addr = (local: string) => `${local}-${run}@accounts.test`;

beforeAll(async () => {
  h = await startHarness({
    config: {
      OPENSEND_PLATFORM_SMTP_HOST: IT.mailpitSmtpHost,
      OPENSEND_PLATFORM_SMTP_PORT: String(IT.mailpitSmtpPort),
      OPENSEND_PLATFORM_SMTP_SECURITY: 'none',
      OPENSEND_PLATFORM_FROM: 'OpenSend Test <no-reply@opensend.test>',
    },
  });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h);
});

async function mailTo(to: string, subjectIncludes: string): Promise<{ text: string }> {
  for (let i = 0; i < 40; i++) {
    const url = new URL('/api/v1/search', IT.mailpitApiUrl);
    url.searchParams.set('query', `to:"${to}"`);
    const found = (await (await fetch(url)).json()) as {
      messages: Array<{ ID: string; Subject: string }>;
    };
    const m = found.messages.find((x) => x.Subject.includes(subjectIncludes));
    if (m) {
      const msg = (await (
        await fetch(new URL(`/api/v1/message/${m.ID}`, IT.mailpitApiUrl))
      ).json()) as { Text: string };
      return { text: msg.Text };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no email to ${to} with "${subjectIncludes}"`);
}
async function mailCount(to: string): Promise<number> {
  const url = new URL('/api/v1/search', IT.mailpitApiUrl);
  url.searchParams.set('query', `to:"${to}"`);
  return ((await (await fetch(url)).json()) as { messages: unknown[] }).messages.length;
}
const linkIn = (text: string) => /(http:\/\/localhost:3000\/\S+)/.exec(text)![1]!;
const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

describe('account emails', () => {
  it('reports that account emails are available', async () => {
    expect((await h.http.get('/api/setup/status')).body.accountEmails).toBe(true);
  });

  it('emails invitations to the invitee', async () => {
    const to = addr('invitee');
    const inv = await t.owner.post(`/api/orgs/${t.orgId}/invitations`, {
      email: to,
      role: 'developer',
    });
    expect(inv.status).toBe(201);
    expect(inv.body.emailSent).toBe(true);
    const mail = await mailTo(to, 'invited');
    expect(linkIn(mail.text)).toBe(inv.body.url);
  });

  it('password reset: single-use link, old password stops working, sessions revoked', async () => {
    const res = await h.http
      .post('/api/auth/request-password-reset')
      .set('origin', WEB_ORIGIN)
      .send({ email: 'owner1@agency.test', redirectTo: `${WEB_ORIGIN}/reset-password` });
    expect(res.status).toBe(200);
    const mail = await mailTo('owner1@agency.test', 'Reset');
    // The emailed link redirects to the dashboard page with the token.
    const callback = await h.http.get(pathOf(linkIn(mail.text)));
    expect(callback.status).toBe(302);
    const token = new URL(callback.headers.location!).searchParams.get('token');
    expect(token).toBeTruthy();
    const newPassword = 'a-brand-new-password-42';
    expect(
      (
        await h.http
          .post('/api/auth/reset-password')
          .set('origin', WEB_ORIGIN)
          .send({ newPassword, token })
      ).status,
    ).toBe(200);
    // Single use.
    expect(
      (
        await h.http
          .post('/api/auth/reset-password')
          .set('origin', WEB_ORIGIN)
          .send({ newPassword: 'another-password-123', token })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    // Existing session revoked, old password rejected, new password works.
    expect((await t.owner.get('/api/me')).status).toBe(401);
    await expect(signIn(h, 'owner1@agency.test', PASSWORD)).rejects.toThrow();
    await expect(signIn(h, 'owner1@agency.test', newPassword)).resolves.toBeTruthy();
  });

  it('does not reveal whether an address has an account', async () => {
    const unknown = addr('nobody');
    const res = await h.http
      .post('/api/auth/request-password-reset')
      .set('origin', WEB_ORIGIN)
      .send({ email: unknown, redirectTo: `${WEB_ORIGIN}/reset-password` });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(await mailCount(unknown)).toBe(0);
  });

  it('verifies the email address of a signed-in user', async () => {
    expect((await t.owner.get('/api/me')).body.user.emailVerified).toBe(false);
    const res = await t.owner.post('/api/auth/send-verification-email', {
      email: 'owner1@agency.test',
      callbackURL: `${WEB_ORIGIN}/`,
    });
    expect(res.status).toBe(200);
    const mail = await mailTo('owner1@agency.test', 'Confirm');
    const verify = await t.owner.get(pathOf(linkIn(mail.text)));
    expect([200, 302]).toContain(verify.status);
    expect((await t.owner.get('/api/me')).body.user.emailVerified).toBe(true);
  });
});

describe('without a platform sender', () => {
  it('invitations still return a link and report emailSent=false', async () => {
    const plain = await startHarness();
    try {
      await resetDatabase(plain);
      resetTenants();
      const tenant = await createTenant(plain);
      const inv = await tenant.owner.post(`/api/orgs/${tenant.orgId}/invitations`, {
        email: addr('manual'),
        role: 'viewer',
      });
      expect(inv.body.emailSent).toBe(false);
      expect(inv.body.url).toContain('/invite?token=');
      expect((await plain.http.get('/api/setup/status')).body.accountEmails).toBe(false);
    } finally {
      await plain.close();
    }
  });
});
