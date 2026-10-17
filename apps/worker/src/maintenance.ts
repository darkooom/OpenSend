import { recordEmailEvent, redact } from '@opensend/core';
import {
  and,
  emailRecipients,
  emails,
  eq,
  providerConnections,
  sendAttempts,
  sql,
} from '@opensend/db';
import { PROVIDER_CAPABILITIES } from '@opensend/providers';
import type { WorkerDeps } from './deps';

/**
 * A job left in `submitting` past its lease (worker crash, network partition) may or may
 * not have reached the provider. It becomes `submission_unknown` – never resent blindly.
 */
export async function reapExpiredLeases(deps: WorkerDeps): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      project_id: string;
      environment_id: string;
      attempt_count: number;
    }>(sql`
      UPDATE emails SET status = 'submission_unknown', failure_category = 'lease_expired',
             last_error_code = 'lease_expired', last_error_message = 'worker lease expired during submission',
             lease_owner = NULL, lease_expires_at = NULL, finalized_at = now(), updated_at = now()
       WHERE id IN (SELECT id FROM emails WHERE status = 'submitting' AND lease_expires_at < now() LIMIT 200 FOR UPDATE SKIP LOCKED)
       RETURNING id, project_id, environment_id, attempt_count`);
    for (const r of rows.rows) {
      await tx
        .update(sendAttempts)
        .set({ outcome: 'unknown', errorCategory: 'lease_expired', finishedAt: new Date() })
        .where(
          and(
            eq(sendAttempts.emailId, r.id),
            eq(sendAttempts.attemptNumber, r.attempt_count),
            eq(sendAttempts.outcome, 'started'),
          ),
        );
      await tx
        .update(emailRecipients)
        .set({ status: 'unknown' })
        .where(and(eq(emailRecipients.emailId, r.id), eq(emailRecipients.status, 'pending')));
      await recordEmailEvent(tx, {
        email: { id: r.id, projectId: r.project_id, environmentId: r.environment_id },
        type: 'email.submission_unknown',
        source: 'system',
        data: { reason: 'lease_expired', note: 'not retried automatically to avoid duplicates' },
        webhookData: { status: 'submission_unknown' },
      });
    }
    return rows.rows.length;
  });
}

/**
 * Provider-assisted clarification of unclear submissions (only for adapters with the
 * `statusLookup` capability). Confirmed acceptance -> submitted; a confirmed absence after a
 * grace period -> failed (eligible for a deliberate manual resend). Others stay unknown.
 */
export async function clarifyUnknownSubmissions(
  deps: WorkerDeps,
  opts: { graceSeconds?: number } = {},
): Promise<{ resolved: number; failed: number }> {
  const grace = opts.graceSeconds ?? 120;
  const candidates = await deps.db
    .select({ email: emails, connection: providerConnections })
    .from(emails)
    .innerJoin(providerConnections, eq(providerConnections.id, emails.providerConnectionId))
    .where(
      and(
        eq(emails.status, 'submission_unknown'),
        sql`${emails.finalizedAt} > now() - interval '3 days'`,
      ),
    )
    .limit(100);
  let resolved = 0;
  let failed = 0;
  for (const { email, connection } of candidates) {
    if (!PROVIDER_CAPABILITIES[connection.type].statusLookup) continue;
    let result;
    const adapter = deps.providers({
      type: connection.type,
      config: connection.config,
      secrets: connection.secretCiphertext
        ? deps.keys.decryptJson(connection.secretCiphertext, `provider_connection:${connection.id}`)
        : {},
    });
    try {
      result = await adapter.lookupStatus({
        messageId: email.messageIdHeader,
        providerMessageId: email.providerMessageId,
      });
    } catch (err) {
      deps.logger.warn(
        { emailId: email.id, err: redact((err as Error).message) },
        'status lookup failed',
      );
      continue;
    } finally {
      await adapter.close().catch(() => undefined);
    }
    const ref = { id: email.id, projectId: email.projectId, environmentId: email.environmentId };
    if (result.status === 'accepted') {
      await deps.db.transaction(async (tx) => {
        const rows = await tx
          .update(emails)
          .set({
            status: 'submitted',
            submittedAt: email.submittedAt ?? new Date(),
            providerMessageId: email.providerMessageId ?? result.providerMessageId,
            updatedAt: new Date(),
          })
          .where(and(eq(emails.id, email.id), eq(emails.status, 'submission_unknown')))
          .returning({ id: emails.id });
        if (!rows.length) return;
        await tx
          .update(emailRecipients)
          .set({ status: 'submitted' })
          .where(and(eq(emailRecipients.emailId, email.id), eq(emailRecipients.status, 'unknown')));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'email.submitted',
          source: 'system',
          data: { resolvedBy: 'provider_status_lookup' },
          webhookData: { status: 'submitted', resolvedBy: 'provider_status_lookup' },
        });
        resolved++;
      });
    } else if (
      result.status === 'not_found' &&
      email.finalizedAt &&
      Date.now() - email.finalizedAt.getTime() > grace * 1000
    ) {
      await deps.db.transaction(async (tx) => {
        const rows = await tx
          .update(emails)
          .set({
            status: 'failed',
            failureCategory: 'not_accepted',
            lastErrorCode: 'not_found_at_provider',
            lastErrorMessage: 'provider confirmed it did not receive the message',
            updatedAt: new Date(),
          })
          .where(and(eq(emails.id, email.id), eq(emails.status, 'submission_unknown')))
          .returning({ id: emails.id });
        if (!rows.length) return;
        await tx
          .update(emailRecipients)
          .set({ status: 'failed' })
          .where(and(eq(emailRecipients.emailId, email.id), eq(emailRecipients.status, 'unknown')));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'email.failed',
          source: 'system',
          data: { resolvedBy: 'provider_status_lookup' },
          webhookData: { status: 'failed', category: 'not_accepted' },
        });
        failed++;
      });
    }
  }
  return { resolved, failed };
}
