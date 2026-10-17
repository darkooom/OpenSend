import { recordEmailEvent } from '@opensend/core';
import { sql } from '@opensend/db';
import type { JobKind, JobPayload, WorkerDeps } from './deps';

export type Enqueue = (kind: JobKind, payload: JobPayload, jobId: string) => Promise<void>;

/** Re-enqueue an outbox row whose job has not completed after this long (Redis loss, crash). */
export const REDISPATCH_AFTER_SECONDS = 300;

/**
 * Transactional-outbox dispatcher. PostgreSQL is the source of truth: rows stay until the
 * job that handles them marks them completed. Rows that were dispatched but never completed
 * (e.g. Redis was flushed or lost) are dispatched again; job ids are derived from the row id
 * so a still-existing job is not duplicated, and every processor re-checks state in the DB.
 * Only due rows are dispatched, so scheduled emails can never be handed out early.
 */
export async function dispatchOutbox(
  deps: WorkerDeps,
  enqueue: Enqueue,
  opts: { limit?: number; redispatchAfterSeconds?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? 200;
  const redispatch = opts.redispatchAfterSeconds ?? REDISPATCH_AFTER_SECONDS;
  return deps.db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: number;
      kind: JobKind;
      ref_id: string;
      project_id: string;
    }>(sql`
      SELECT id, kind, ref_id, project_id FROM outbox
       WHERE completed_at IS NULL
         AND available_at <= now()
         AND (dispatched_at IS NULL OR dispatched_at < now() - make_interval(secs => ${redispatch}))
       ORDER BY available_at, id
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED`);
    for (const row of rows.rows) {
      if (row.kind === 'send_email') {
        // A due scheduled email becomes queued when it is handed to the queue.
        const moved = await tx.execute<{ id: string; environment_id: string }>(sql`
          UPDATE emails SET status = 'queued', updated_at = now()
           WHERE id = ${row.ref_id} AND status = 'scheduled' AND scheduled_at <= now()
           RETURNING id, environment_id`);
        const m = moved.rows[0];
        if (m) {
          await recordEmailEvent(tx, {
            email: { id: m.id, projectId: row.project_id, environmentId: m.environment_id },
            type: 'email.queued',
            source: 'system',
          });
        }
      }
      await enqueue(
        row.kind,
        { outboxId: Number(row.id), refId: row.ref_id },
        `${row.kind}-${row.id}`,
      );
      await tx.execute(
        sql`UPDATE outbox SET dispatched_at = now(), dispatch_count = dispatch_count + 1 WHERE id = ${row.id}`,
      );
    }
    return rows.rows.length;
  });
}

export async function completeOutbox(deps: WorkerDeps, outboxId: number): Promise<void> {
  await deps.db.execute(
    sql`UPDATE outbox SET completed_at = now() WHERE id = ${outboxId} AND completed_at IS NULL`,
  );
}

/** Postpone a row (e.g. project paused) without marking it completed. */
export async function postponeOutbox(
  deps: WorkerDeps,
  outboxId: number,
  seconds: number,
): Promise<void> {
  await deps.db.execute(sql`
    UPDATE outbox SET available_at = now() + make_interval(secs => ${seconds}), dispatched_at = NULL
     WHERE id = ${outboxId} AND completed_at IS NULL`);
}
