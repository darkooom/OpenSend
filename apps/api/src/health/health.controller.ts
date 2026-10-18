import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import type { ObjectStore } from '@opensend/core';
import { sql, type Database } from '@opensend/db';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { ApiError } from '../common/errors';
import { CONFIG, DB, OBJECT_STORE, REDIS } from '../infra/tokens';

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is running and the event loop responds. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL is required; Redis and object storage are reported. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await withTimeout(fn(), 2000);
        return 'ok';
      } catch {
        return 'unavailable';
      }
    };
    const [postgres, redis, objectStorage] = await Promise.all([
      check(() => this.db.execute(sql`SELECT 1`)),
      check(() => this.redis.ping()),
      check(() => this.store.ping()),
    ]);
    // Public writes fail closed without Redis because it carries the abuse-control budget.
    const ready = postgres === 'ok' && redis === 'ok' && objectStorage === 'ok';
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks: { postgres, redis, objectStorage } };
  }

  /** Prometheus metrics. OPENSEND_METRICS_TOKEN is mandatory in production. */
  @Get('metrics')
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const token = this.config.OPENSEND_METRICS_TOKEN;
    if (token) {
      const expected = Buffer.from(`Bearer ${token}`);
      const supplied = Buffer.from(auth ?? '');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        throw new ApiError('unauthorized', 'metrics token required');
      }
    }
    const status = await this.db.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*)::int AS n FROM emails GROUP BY status`,
    );
    const [age] = (
      await this.db.execute<{ age: number | null }>(sql`
        SELECT EXTRACT(EPOCH FROM now() - min(available_at))::float AS age FROM outbox
         WHERE completed_at IS NULL AND available_at <= now()`)
    ).rows;
    const attempts = await this.db.execute<{ outcome: string; n: number }>(sql`
      SELECT outcome, count(*)::int AS n FROM send_attempts WHERE started_at > now() - interval '1 hour' GROUP BY outcome`);
    const hooks = await this.db.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*)::int AS n FROM webhook_deliveries WHERE status <> 'succeeded' GROUP BY status`,
    );
    const unmatched = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provider_events WHERE match_status IN ('pending', 'unmatched')`,
    );
    const lines = [
      '# HELP opensend_emails Emails by status.',
      '# TYPE opensend_emails gauge',
      ...status.rows.map((r) => `opensend_emails{status="${r.status}"} ${r.n}`),
      '# HELP opensend_outbox_oldest_age_seconds Age of the oldest due, unprocessed outbox entry.',
      '# TYPE opensend_outbox_oldest_age_seconds gauge',
      `opensend_outbox_oldest_age_seconds ${age?.age ?? 0}`,
      '# HELP opensend_send_attempts_last_hour Send attempts in the last hour by outcome.',
      '# TYPE opensend_send_attempts_last_hour gauge',
      ...attempts.rows.map(
        (r) => `opensend_send_attempts_last_hour{outcome="${r.outcome}"} ${r.n}`,
      ),
      '# HELP opensend_webhook_deliveries_open Webhook deliveries not yet succeeded.',
      '# TYPE opensend_webhook_deliveries_open gauge',
      ...hooks.rows.map((r) => `opensend_webhook_deliveries_open{status="${r.status}"} ${r.n}`),
      '# HELP opensend_provider_events_unmatched Provider events waiting for a matching email.',
      '# TYPE opensend_provider_events_unmatched gauge',
      `opensend_provider_events_unmatched ${unmatched.rows[0]?.n ?? 0}`,
    ];
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  }
}
