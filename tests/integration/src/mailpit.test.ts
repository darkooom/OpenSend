import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IT } from './env';
import {
  createTenant,
  drain,
  resetDatabase,
  resetTenants,
  startHarness,
  v1,
  type Harness,
  type Tenant,
} from './harness';

/** Uses the REAL local provider: SMTP into Mailpit and the Mailpit search API. */
let h: Harness;
let t: Tenant;
beforeAll(async () => {
  h = await startHarness({ realProviders: true });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h);
  resetTenants();
  t = await createTenant(h, { domain: 'mailpit-it.test' });
});

async function findInMailpit(messageId: string) {
  const url = new URL('/api/v1/search', IT.mailpitApiUrl);
  url.searchParams.set('query', `message-id:"${messageId}"`);
  const res = await fetch(url);
  return (await res.json()) as {
    messages: Array<{
      ID: string;
      Subject: string;
      To: Array<{ Address: string }>;
      Bcc: Array<{ Address: string }>;
    }>;
  };
}

describe('local provider (Mailpit)', () => {
  it('delivers into Mailpit and reports only "submitted"', async () => {
    const subject = `IT ${Date.now()}`;
    const r = await v1(h, t.apiKey).post('/v1/emails', {
      from: 'Test <hello@mailpit-it.test>',
      to: ['to@example.test'],
      bcc: ['hidden@example.test'],
      subject,
      html: '<p>Hello from the integration test</p>',
      text: 'Hello',
      attachments: [{ filename: 'note.txt', content: Buffer.from('attached').toString('base64') }],
    });
    expect(r.status).toBe(202);
    await drain(h);
    const e = (await v1(h, t.apiKey).get(`/v1/emails/${r.body.id}`)).body;
    expect(e.status).toBe('submitted');
    expect(e.summary.delivered).toBe(0); // Mailpit acceptance is not a delivery event
    const found = await findInMailpit(`${r.body.id}@mailpit-it.test`);
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]!.Subject).toBe(subject);
    const raw = await (
      await fetch(new URL(`/api/v1/message/${found.messages[0]!.ID}/raw`, IT.mailpitApiUrl))
    ).text();
    // The Bcc recipient received it (Mailpit itself prepends a Bcc display header to stored
    // messages, so header absence is asserted in the MIME composer unit test instead).
    expect(found.messages[0]!.Bcc.map((b) => b.Address)).toContain('hidden@example.test');
    expect(raw.toLowerCase()).toContain('x-opensend-email-id');
    expect(raw).toContain('note.txt');
  });
});
