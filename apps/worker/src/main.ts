import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { parseConfig } from '@opensend/config';
import { KeyRing, S3ObjectStore, createLogger } from '@opensend/core';
import { createDb, sql } from '@opensend/db';
import { createProviderAdapter } from '@opensend/providers';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { QUEUES, type JobKind, type JobPayload, type WorkerDeps } from './deps';
import { dispatchOutbox } from './dispatcher';
import { clarifyUnknownSubmissions, reapExpiredLeases } from './maintenance';
import { processProviderEvent, reconcileProviderEvents } from './provider-events';
import { recheckDomainOwnership } from './domains';
import { runRetention } from './retention';
import { processSendEmail } from './send';
import { processWebhookDelivery } from './webhooks';

async function main() {
  const config = parseConfig();
  const logger = createLogger({ name: 'opensend-worker', level: config.LOG_LEVEL });
  const handle = createDb(config.DATABASE_URL, { max: 20, applicationName: 'opensend-worker' });
  const store = new S3ObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
  const deps: WorkerDeps = {
    db: handle.db,
    config,
    keys: KeyRing.fromEnv(
      config.OPENSEND_ENCRYPTION_KEYS,
      config.OPENSEND_ENCRYPTION_ACTIVE_KEY_ID,
    ),
    store,
    logger,
    workerId: `${hostname()}:${process.pid}:${Date.now().toString(36)}`,
    providers: (spec) =>
      createProviderAdapter(spec, {
        timeoutMs: config.OPENSEND_PROVIDER_TIMEOUT_MS,
        policy: { privateHostAllowlist: config.OPENSEND_PRIVATE_NETWORK_ALLOWLIST },
        localEnabled: config.OPENSEND_LOCAL_PROVIDER_ENABLED,
        mailpit: {
          smtpHost: config.MAILPIT_SMTP_HOST,
          smtpPort: config.MAILPIT_SMTP_PORT,
          apiUrl: config.MAILPIT_API_URL,
        },
      }),
  };

  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
  const queues = Object.fromEntries(
    (Object.keys(QUEUES) as JobKind[]).map((k) => [
      k,
      new Queue(QUEUES[k], { connection, prefix: 'opensend' }),
    ]),
  ) as Record<JobKind, Queue>;

  const enqueue = async (kind: JobKind, payload: JobPayload, jobId: string) => {
    // Payloads carry ids only; content and credentials stay in PostgreSQL (encrypted).
    await queues[kind].add(kind, payload, {
      jobId,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
    });
  };

  const handlers: Record<JobKind, (job: Job<JobPayload>) => Promise<unknown>> = {
    send_email: (job) => processSendEmail(deps, job.data.refId, job.data.outboxId),
    deliver_webhook: (job) => processWebhookDelivery(deps, job.data.refId, job.data.outboxId),
    process_provider_event: (job) => processProviderEvent(deps, job.data.refId, job.data.outboxId),
  };
  const concurrency: Record<JobKind, number> = {
    send_email: 10,
    deliver_webhook: 10,
    process_provider_event: 5,
  };
  const workers = (Object.keys(QUEUES) as JobKind[]).map((kind) => {
    const w = new Worker<JobPayload>(
      QUEUES[kind],
      async (job) => {
        const started = Date.now();
        const result = await handlers[kind](job);
        logger.info(
          { kind, refId: job.data.refId, result, ms: Date.now() - started },
          'job processed',
        );
        return result;
      },
      {
        connection: connection.duplicate({ maxRetriesPerRequest: null }),
        prefix: 'opensend',
        concurrency: concurrency[kind],
      },
    );
    // A failed job leaves its outbox row incomplete; the dispatcher re-dispatches it later.
    w.on('failed', (job, err) =>
      logger.error({ kind, refId: job?.data.refId, err: err.message }, 'job failed'),
    );
    return w;
  });

  // ---- periodic loops ----------------------------------------------------------------------
  let stopping = false;
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, fn: () => Promise<unknown>, initialDelay = ms) => {
    let running = false;
    const tick = async () => {
      if (stopping || running) return;
      running = true;
      try {
        const out = await fn();
        if (
          out &&
          (typeof out === 'number'
            ? out > 0
            : Object.values(out as object).some((v) => typeof v === 'number' && v > 0))
        ) {
          logger.info({ task: name, result: out }, 'maintenance task');
        }
      } catch (err) {
        logger.error({ task: name, err: (err as Error).message }, 'maintenance task failed');
      } finally {
        running = false;
      }
    };
    timers.push(setTimeout(() => void tick(), initialDelay));
    timers.push(setInterval(() => void tick(), ms));
  };
  every('dispatch', 1000, () => dispatchOutbox(deps, enqueue), 200);
  every('reap-leases', 30_000, () => reapExpiredLeases(deps));
  every('clarify-unknown', 60_000, () => clarifyUnknownSubmissions(deps));
  every('reconcile-provider-events', 60_000, () => reconcileProviderEvents(deps));
  every('recheck-domains', 15 * 60_000, () => recheckDomainOwnership(deps), 120_000);
  every('retention', 10 * 60_000, () => runRetention(deps), 60_000);

  // ---- health endpoint for orchestration ---------------------------------------------------
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 3002);
  const server = createServer(async (req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/health/ready') {
      const pg = await handle.db.execute(sql`SELECT 1`).then(
        () => 'ok',
        () => 'unavailable',
      );
      const redis = await connection.ping().then(
        () => 'ok',
        () => 'unavailable',
      );
      const ready = pg === 'ok' && redis === 'ok';
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: ready ? 'ready' : 'not_ready',
          checks: { postgres: pg, redis },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0');
  logger.info({ workerId: deps.workerId, healthPort: port }, 'worker started');

  // ---- graceful shutdown ---------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down: waiting for active jobs');
    timers.forEach((t) => clearInterval(t));
    const hardStop = setTimeout(() => {
      logger.error(
        'graceful shutdown timed out; in-flight sends will be reaped as submission_unknown if they did not finish',
      );
      process.exit(1);
    }, 60_000);
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(Object.values(queues).map((q) => q.close()));
    server.close();
    connection.disconnect();
    await handle.close();
    clearTimeout(hardStop);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[opensend-worker] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
