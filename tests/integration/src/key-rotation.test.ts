import { randomBytes } from 'node:crypto';
import { rotateEncryption } from '@opensend/api';
import { KeyRing, getDecrypted } from '@opensend/core';
import {
  emailAttachments,
  emailContents,
  providerConnections,
  sql,
  webhookEndpoints,
} from '@opensend/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTenant,
  resetDatabase,
  resetTenants,
  sampleEmail,
  startHarness,
  v1,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ config: { OPENSEND_PRIVATE_NETWORK_ALLOWLIST: 'localhost' } });
  await resetDatabase(h);
  resetTenants();
});
afterAll(async () => h.close());

describe('encryption key rotation', () => {
  it('re-encrypts credentials, webhook secrets, content and attachment objects', async () => {
    const t = await createTenant(h, { envKind: 'production', domain: 'rotate-mail.io' });
    const base = `/api/projects/${t.projectId}/environments/${t.envId}`;
    await h.db.execute(
      sql`UPDATE projects SET content_retention_days = 30, attachment_retention_days = 30`,
    );
    await t.owner.post(`${base}/webhooks`, {
      url: 'http://localhost:9/hook',
      eventTypes: ['email.submitted'],
    });
    const [d] = (await t.owner.get(`${base}/domains`)).body;
    h.dns.txt.set(d.ownership.record.name, [d.ownership.record.value]);
    h.provider.domainSetup = { status: 'verified', records: [] };
    await t.owner.post(`${base}/domains/${d.id}/verify`);
    const sent = await v1(h, t.apiKey).post(
      '/v1/emails',
      sampleEmail({
        from: 'hello@rotate-mail.io',
        attachments: [
          { filename: 'a.txt', content: Buffer.from('attached bytes').toString('base64') },
        ],
      }),
    );
    expect(sent.status).toBe(202);

    const oldSpec = h.config.OPENSEND_ENCRYPTION_KEYS;
    const v2 = randomBytes(32).toString('base64');
    const rotating = KeyRing.fromEnv(`${oldSpec},v2:${v2}`, 'v2');
    const report = await rotateEncryption(h.db, h.store, rotating);
    expect(report).toMatchObject({
      connections: 1,
      webhookSecrets: 1,
      contents: 1,
      attachments: 1,
      failedAttachments: 0,
    });

    // Everything is readable with ONLY the new key.
    const onlyNew = KeyRing.fromEnv(`v2:${v2}`, 'v2');
    const [conn] = await h.db.select().from(providerConnections);
    expect(
      onlyNew.decryptJson<{ accessKeyId: string }>(
        conn!.secretCiphertext!,
        `provider_connection:${conn!.id}`,
      ).accessKeyId,
    ).toBe('AKIAFAKEFAKEFAKEFAKE');
    const [hook] = await h.db.select().from(webhookEndpoints);
    expect(onlyNew.decrypt(hook!.secretCiphertext, `webhook_secret:${hook!.id}`)).toMatch(
      /^whsec_/,
    );
    const [content] = await h.db.select().from(emailContents);
    expect(
      onlyNew.decryptJson<{ html: string }>(
        content!.ciphertext,
        `email_content:${content!.emailId}`,
      ).html,
    ).toBe('<p>Hi</p>');
    const [att] = await h.db.select().from(emailAttachments);
    expect((await getDecrypted(h.store, onlyNew, att!.objectKey)).toString()).toBe(
      'attached bytes',
    );

    // Idempotent: nothing left to do.
    expect(await rotateEncryption(h.db, h.store, rotating)).toMatchObject({
      connections: 0,
      webhookSecrets: 0,
      contents: 0,
      attachments: 0,
    });
  });
});
