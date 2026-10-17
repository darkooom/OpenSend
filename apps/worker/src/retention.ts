import { recordEmailEvent } from '@opensend/core';
import { eq, emailAttachments, emails, sql, type Tx } from '@opensend/db';
import type { WorkerDeps } from './deps';

/**
 * Central deletion process. All statements are scoped by joins on the email's own project,
 * so one project's policy can never delete another project's data.
 *
 * Content (subject, html, text, headers) of a final email is purged once
 * `content_retention_days` have passed (0 = immediately after the final state). Emails in
 * `submission_unknown` keep their content for at least 7 days so a person can resolve or
 * resend them. Metadata, recipients and events are deleted after `event_retention_days`.
 */
const PURGEABLE = sql`('submitted', 'failed', 'cancelled', 'suppressed')`;

export async function purgeContentIfDue(
  tx: Tx,
  _deps: WorkerDeps,
  emailId: string,
): Promise<boolean> {
  const res = await tx.execute<{ id: string; project_id: string; environment_id: string }>(sql`
    UPDATE emails e SET subject = NULL, content_purged_at = now(), updated_at = now()
      FROM projects p
     WHERE e.id = ${emailId} AND p.id = e.project_id
       AND e.content_purged_at IS NULL
       AND p.content_retention_days = 0
       AND e.status IN ${PURGEABLE}
     RETURNING e.id, e.project_id, e.environment_id`);
  const row = res.rows[0];
  if (!row) return false;
  await tx.execute(sql`DELETE FROM email_contents WHERE email_id = ${emailId}`);
  await recordEmailEvent(tx, {
    email: { id: row.id, projectId: row.project_id, environmentId: row.environment_id },
    type: 'email.content_purged',
    source: 'system',
    data: { policy: 'content_retention_days=0' },
  });
  return true;
}

export interface RetentionReport {
  contentPurged: number;
  attachmentsPurged: number;
  emailsDeleted: number;
  objectsDeleted: number;
  providerEventsDeleted: number;
  webhookEventsDeleted: number;
  idempotencyKeysDeleted: number;
}

export async function runRetention(
  deps: WorkerDeps,
  opts: { batch?: number } = {},
): Promise<RetentionReport> {
  const { db, store, logger } = deps;
  const batch = opts.batch ?? 500;
  const report: RetentionReport = {
    contentPurged: 0,
    attachmentsPurged: 0,
    emailsDeleted: 0,
    objectsDeleted: 0,
    providerEventsDeleted: 0,
    webhookEventsDeleted: 0,
    idempotencyKeysDeleted: 0,
  };

  // 1. content
  const content = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; project_id: string; environment_id: string }>(sql`
      UPDATE emails e SET subject = NULL, content_purged_at = now(), updated_at = now()
        FROM projects p
       WHERE p.id = e.project_id AND e.content_purged_at IS NULL AND e.id IN (
         SELECT e2.id FROM emails e2 JOIN projects p2 ON p2.id = e2.project_id
          WHERE e2.content_purged_at IS NULL AND e2.finalized_at IS NOT NULL
            AND (
              (e2.status IN ${PURGEABLE} AND e2.finalized_at < now() - make_interval(days => p2.content_retention_days))
              OR (e2.status = 'submission_unknown' AND e2.finalized_at < now() - make_interval(days => GREATEST(p2.content_retention_days, 7)))
            )
          LIMIT ${batch})
       RETURNING e.id, e.project_id, e.environment_id`);
    for (const r of rows.rows) {
      await tx.execute(sql`DELETE FROM email_contents WHERE email_id = ${r.id}`);
      await recordEmailEvent(tx, {
        email: { id: r.id, projectId: r.project_id, environmentId: r.environment_id },
        type: 'email.content_purged',
        source: 'system',
        data: { policy: 'content_retention' },
      });
    }
    return rows.rows.length;
  });
  report.contentPurged = content;

  // 2. attachments (objects first, then mark)
  const dueAttachments = await db.execute<{ id: string; object_key: string }>(sql`
    SELECT a.id, a.object_key FROM email_attachments a
      JOIN emails e ON e.id = a.email_id
      JOIN projects p ON p.id = e.project_id AND p.id = a.project_id
     WHERE a.purged_at IS NULL AND e.finalized_at IS NOT NULL
       AND (
         (e.status IN ${PURGEABLE} AND e.finalized_at < now() - make_interval(days => p.attachment_retention_days))
         OR (e.status = 'submission_unknown' AND e.finalized_at < now() - make_interval(days => GREATEST(p.attachment_retention_days, 7)))
       )
     LIMIT ${batch}`);
  for (const a of dueAttachments.rows) {
    try {
      await store.delete(a.object_key);
      await db
        .update(emailAttachments)
        .set({ purgedAt: new Date() })
        .where(eq(emailAttachments.id, a.id));
      report.attachmentsPurged++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, attachmentId: a.id }, 'attachment purge failed');
    }
  }

  // 3. whole emails past event retention (objects of any remaining attachments first)
  const expired = await db.execute<{ id: string }>(sql`
    SELECT e.id FROM emails e JOIN projects p ON p.id = e.project_id
     WHERE e.accepted_at < now() - make_interval(days => p.event_retention_days)
       AND e.status IN ('submitted', 'failed', 'cancelled', 'suppressed', 'submission_unknown')
     LIMIT ${batch}`);
  for (const e of expired.rows) {
    const objects = await db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.emailId, e.id));
    let objectsOk = true;
    for (const o of objects.filter((x) => !x.purgedAt)) {
      try {
        await store.delete(o.objectKey);
        report.objectsDeleted++;
      } catch {
        objectsOk = false;
      }
    }
    if (!objectsOk) continue; // retry next run, never orphan objects
    await db.delete(emails).where(eq(emails.id, e.id));
    report.emailsDeleted++;
  }

  // 4. raw provider events and webhook events (longest project retention applies to unmatched events)
  const pe = await db.execute(sql`
    DELETE FROM provider_events pe
     WHERE (pe.project_id IS NOT NULL AND pe.received_at < now() - make_interval(days => (SELECT event_retention_days FROM projects WHERE id = pe.project_id)))
        OR (pe.project_id IS NULL AND pe.received_at < now() - interval '30 days')`);
  report.providerEventsDeleted = pe.rowCount ?? 0;
  const we = await db.execute(sql`
    DELETE FROM webhook_events we USING projects p
     WHERE p.id = we.project_id AND we.created_at < now() - make_interval(days => p.event_retention_days)`);
  report.webhookEventsDeleted = we.rowCount ?? 0;

  // 5. idempotency keys: expired AND the email (if any) is final
  const ik = await db.execute(sql`
    DELETE FROM idempotency_keys k
     WHERE k.expires_at < now()
       AND (k.email_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM emails e WHERE e.id = k.email_id AND e.status IN ('accepted', 'scheduled', 'queued', 'submitting', 'retry_wait')))`);
  report.idempotencyKeysDeleted = ik.rowCount ?? 0;

  return report;
}
