import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'drizzle');

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, { max: 1, applicationName: 'opensend-migrate' });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.warn('[opensend] migrations applied');
    })
    .catch((err: unknown) => {
      console.error('[opensend] migration failed', err);
      process.exit(1);
    });
}
