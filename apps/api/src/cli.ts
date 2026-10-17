import { parseConfig } from '@opensend/config';
import { KeyRing, generateEncryptionKey } from '@opensend/core';
import { createDb, eq, providerConnections, sql, webhookEndpoints } from '@opensend/db';
import { configureInfra } from './infra/infra.module';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SetupService } from './setup/setup.service';

/**
 * Operator CLI:
 *   bootstrap-token        one-time token for the first-owner setup page (valid 60 min)
 *   generate-key           print a new random encryption key (base64, 32 bytes)
 *   rotate-encryption      re-encrypt stored secrets with the active key id
 */
async function main() {
  const [command] = process.argv.slice(2);
  if (command === 'generate-key') {
    console.warn(generateEncryptionKey());
    return;
  }
  const config = parseConfig();
  if (command === 'bootstrap-token') {
    configureInfra({ config });
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      const token = await app.get(SetupService).createBootstrapToken();
      console.warn('One-time setup token (valid for 60 minutes):');
      console.warn(token);
      console.warn(`Open ${config.PUBLIC_WEB_URL.replace(/\/$/, '')}/setup and paste the token.`);
    } finally {
      await app.close();
    }
    return;
  }
  if (command === 'rotate-encryption') {
    const keys = KeyRing.fromEnv(
      config.OPENSEND_ENCRYPTION_KEYS,
      config.OPENSEND_ENCRYPTION_ACTIVE_KEY_ID,
    );
    const { db, close } = createDb(config.DATABASE_URL, { max: 2 });
    let n = 0;
    try {
      for (const c of await db.select().from(providerConnections)) {
        if (c.secretCiphertext && keys.needsRotation(c.secretCiphertext)) {
          const aad = `provider_connection:${c.id}`;
          await db
            .update(providerConnections)
            .set({ secretCiphertext: keys.encrypt(keys.decrypt(c.secretCiphertext, aad), aad) })
            .where(eq(providerConnections.id, c.id));
          n++;
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
          n++;
        }
      }
      // Email contents are short-lived; re-encrypt in batches.
      const rows = await db.execute<{ email_id: string; ciphertext: string }>(
        sql`SELECT email_id, ciphertext FROM email_contents`,
      );
      for (const r of rows.rows) {
        if (keys.needsRotation(r.ciphertext)) {
          const aad = `email_content:${r.email_id}`;
          await db.execute(
            sql`UPDATE email_contents SET ciphertext = ${keys.encrypt(keys.decrypt(r.ciphertext, aad), aad)} WHERE email_id = ${r.email_id}`,
          );
          n++;
        }
      }
      console.warn(
        `re-encrypted ${n} value(s) with key "${keys.activeKeyId}". Attachment objects are re-encrypted lazily on purge/expiry; keep old keys until attachment retention has passed.`,
      );
    } finally {
      await close();
    }
    return;
  }
  console.error('usage: cli <bootstrap-token | generate-key | rotate-encryption>');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
