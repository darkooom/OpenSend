import { parseConfig } from '@opensend/config';
import { KeyRing, S3ObjectStore, generateEncryptionKey } from '@opensend/core';
import { createDb } from '@opensend/db';
import { rotateEncryption } from './maintenance/rotate-encryption';
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
    const store = new S3ObjectStore({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
    try {
      const r = await rotateEncryption(db, store, keys);
      console.warn(`re-encrypted with key "${keys.activeKeyId}":`, JSON.stringify(r));
      if (r.failedAttachments > 0) {
        console.error(
          `${r.failedAttachments} attachment object(s) could not be re-encrypted. Keep the old key and run again.`,
        );
        process.exitCode = 1;
      } else {
        console.warn('Done. Old keys can be removed from OPENSEND_ENCRYPTION_KEYS.');
      }
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
