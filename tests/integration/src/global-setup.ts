import { runMigrations } from '@opensend/db';
import Redis from 'ioredis';
import pg from 'pg';
import { IT } from './env';

/** Creates a fresh database for this run and applies all migrations. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: IT.adminDatabaseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${IT.databaseName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${IT.databaseName}`);
  await admin.end();
  await runMigrations(IT.databaseUrl);
  const redis = new Redis(IT.redisUrl);
  await redis.flushdb();
  redis.disconnect();
}
