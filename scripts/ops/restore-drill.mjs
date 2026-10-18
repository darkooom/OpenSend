#!/usr/bin/env node
// Backup/restore drill: pg_dump a database, restore it into a scratch database, apply
// migrations, and compare row counts table by table. Uses the docker-compose postgres service.
//   node scripts/ops/restore-drill.mjs [sourceDb]
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const pg = createRequire(path.join(root, 'packages/db/package.json'))('pg');
const source = process.argv[2] ?? 'opensend';
const target = `${source}_restore_drill`;
const admin =
  process.env.DRILL_ADMIN_DATABASE_URL ?? 'postgres://opensend:opensend@localhost:54329/postgres';
const url = (db) => admin.replace(/\/[^/]*$/, `/${db}`);
const compose = (...args) =>
  execFileSync('docker', ['compose', ...args], { cwd: root, maxBuffer: 1024 * 1024 * 512 });

const t0 = Date.now();
console.log(`1/4 pg_dump ${source} (custom format)`);
const dump = compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'opensend', '-Fc', source);
console.log(`    ${(dump.length / 1024).toFixed(0)} KiB`);

console.log(`2/4 restore into ${target}`);
const c = new pg.Client({ connectionString: admin });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${target}`);
await c.end();
const restore = spawnSync(
  'docker',
  ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'opensend', '-d', target, '--no-owner'],
  { cwd: root, input: dump },
);
if (restore.status !== 0) {
  console.error(restore.stderr.toString());
  process.exit(1);
}

console.log('3/4 apply migrations to the restored database');
execFileSync(process.execPath, ['packages/db/dist/migrate.js'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: url(target) },
  stdio: 'inherit',
});

console.log('4/4 compare row counts');
const counts = async (db) => {
  const cl = new pg.Client({ connectionString: url(db) });
  await cl.connect();
  const tables = (
    await cl.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
  ).rows.map((r) => r.tablename);
  const out = {};
  for (const t of tables)
    out[t] = Number((await cl.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
  await cl.end();
  return out;
};
const [a, b] = await Promise.all([counts(source), counts(target)]);
let mismatches = 0;
for (const t of Object.keys(a)) {
  if (a[t] !== b[t]) {
    mismatches++;
    console.log(`    MISMATCH ${t}: ${a[t]} vs ${b[t]}`);
  }
}
const total = Object.values(a).reduce((x, y) => x + y, 0);
console.log(
  `    ${Object.keys(a).length} tables, ${total} rows, ${mismatches} mismatches, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
if (process.env.DRILL_KEEP !== '1') {
  const d = new pg.Client({ connectionString: admin });
  await d.connect();
  await d.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
  await d.end();
}
process.exit(mismatches ? 1 : 0);
