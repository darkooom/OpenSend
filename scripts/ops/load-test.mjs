#!/usr/bin/env node
// Load test of acceptance + processing against a running instance (use the local provider!).
//   OPENSEND_URL=http://localhost:3001 OPENSEND_API_KEY=os_... FROM=hello@myapp.test \
//   node scripts/ops/load-test.mjs --total 2000 --concurrency 25 [--recipients 1]
// Reports acceptance latency percentiles, throughput, and the time until nothing is pending.
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const url = process.env.OPENSEND_URL ?? 'http://localhost:3001';
const key = process.env.OPENSEND_API_KEY;
const from = process.env.FROM;
if (!key || !from) {
  console.error('OPENSEND_API_KEY and FROM are required');
  process.exit(2);
}
const total = arg('total', 1000);
const concurrency = arg('concurrency', 20);
const recipients = arg('recipients', 1);
const run = Date.now().toString(36);

const latencies = [];
const statuses = {};
let next = 0;
const t0 = performance.now();
async function worker() {
  while (next < total) {
    const i = next++;
    const body = {
      from,
      to: Array.from({ length: recipients }, (_, r) => `load-${run}-${i}-${r}@load.test`),
      subject: `Load ${run} #${i}`,
      text: 'load test',
      tags: { run },
    };
    const s = performance.now();
    const res = await fetch(`${url}/v1/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': `load-${run}-${i}`,
      },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    latencies.push(performance.now() - s);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
const acceptSeconds = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const p = (q) =>
  latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1);

console.log(
  `accepted ${total} requests in ${acceptSeconds.toFixed(1)} s → ${(total / acceptSeconds).toFixed(0)} req/s (concurrency ${concurrency}, ${recipients} recipient(s) each)`,
);
console.log(`status codes: ${JSON.stringify(statuses)}`);
console.log(
  `latency ms: p50 ${p(0.5)} · p95 ${p(0.95)} · p99 ${p(0.99)} · max ${latencies[latencies.length - 1].toFixed(1)}`,
);

// Drain: wait until no email of this run is pending.
const d0 = performance.now();
for (;;) {
  const r = await (
    await fetch(`${url}/v1/usage`, { headers: { authorization: `Bearer ${key}` } })
  ).json();
  if (r.pending === 0) break;
  if ((performance.now() - d0) / 1000 > 600) {
    console.log(`still ${r.pending} pending after 600 s`);
    process.exit(1);
  }
  await new Promise((res) => setTimeout(res, 500));
}
const drainSeconds = (performance.now() - t0) / 1000;
console.log(
  `all handed off ${drainSeconds.toFixed(1)} s after start → ${(total / drainSeconds).toFixed(0)} emails/s end to end`,
);
