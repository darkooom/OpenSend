import { KeyRing, type Logger, type ObjectStore } from '@opensend/core';
import {
  emailAttachments,
  eq,
  isNull,
  providerConnections,
  sql,
  webhookEndpoints,
  type Database,
} from '@opensend/db';

export interface RotationReport {
  connections: number;
  webhookSecrets: number;
  contents: number;
  attachments: number;
  failedAttachments: number;
}

/**
 * Re-encrypts every stored secret and all stored content with the key ring's ACTIVE key:
 * provider credentials, webhook secrets, email contents and attachment objects. Values that
 * already use the active key are skipped, so the command can be re-run safely. Keep old keys
 * configured until it reports zero failures.
 */
export async function rotateEncryption(
  db: Database,
  store: ObjectStore,
  keys: KeyRing,
  logger?: Logger,
): Promise<RotationReport> {
  const report: RotationReport = {
    connections: 0,
    webhookSecrets: 0,
    contents: 0,
    attachments: 0,
    failedAttachments: 0,
  };

  for (const c of await db.select().from(providerConnections)) {
    if (c.secretCiphertext && keys.needsRotation(c.secretCiphertext)) {
      const aad = `provider_connection:${c.id}`;
      await db
        .update(providerConnections)
        .set({ secretCiphertext: keys.encrypt(keys.decrypt(c.secretCiphertext, aad), aad) })
        .where(eq(providerConnections.id, c.id));
      report.connections++;
    }
  }

  for (const w of await db.select().from(webhookEndpoints)) {
    const patch: Partial<typeof webhookEndpoints.$inferInsert> = {};
    if (keys.needsRotation(w.secretCiphertext))
      patch.secretCiphertext = keys.encrypt(
        keys.decrypt(w.secretCiphertext, `webhook_secret:${w.id}`),
        `webhook_secret:${w.id}`,
      );
    if (w.previousSecretCiphertext && keys.needsRotation(w.previousSecretCiphertext)) {
      patch.previousSecretCiphertext = keys.encrypt(
        keys.decrypt(w.previousSecretCiphertext, `webhook_secret_prev:${w.id}`),
        `webhook_secret_prev:${w.id}`,
      );
    }
    if (Object.keys(patch).length) {
      await db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, w.id));
      report.webhookSecrets++;
    }
  }

  const contents = await db.execute<{ email_id: string; ciphertext: string }>(
    sql`SELECT email_id, ciphertext FROM email_contents`,
  );
  for (const r of contents.rows) {
    if (!keys.needsRotation(r.ciphertext)) continue;
    const aad = `email_content:${r.email_id}`;
    await db.execute(
      sql`UPDATE email_contents SET ciphertext = ${keys.encrypt(keys.decrypt(r.ciphertext, aad), aad)} WHERE email_id = ${r.email_id}`,
    );
    report.contents++;
  }

  // Attachment objects: read, re-encrypt, overwrite under the same server-generated key.
  for (const a of await db
    .select({ objectKey: emailAttachments.objectKey })
    .from(emailAttachments)
    .where(isNull(emailAttachments.purgedAt))) {
    try {
      const stored = await store.get(a.objectKey);
      if (!keys.needsRotation(stored.toString('utf8', 0, 64))) continue;
      const aad = `object:${a.objectKey}`;
      await store.put(
        a.objectKey,
        keys.encryptBuffer(keys.decryptBuffer(stored, aad), aad),
        'application/octet-stream',
      );
      report.attachments++;
    } catch (err) {
      report.failedAttachments++;
      logger?.warn(
        { objectKey: a.objectKey, err: (err as Error).message },
        'attachment re-encryption failed',
      );
    }
  }
  return report;
}
