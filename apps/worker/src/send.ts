import { FINAL_STATUSES } from '@opensend/contracts';
import {
  backoffDelayMs,
  enqueueOutbox,
  findSuppressed,
  getDecrypted,
  recordEmailEvent,
  redact,
} from '@opensend/core';
import {
  and,
  domains,
  emailAttachments,
  emailContents,
  emailRecipients,
  emails,
  eq,
  isNull,
  projects,
  providerConnections,
  sendAttempts,
  sql,
  type Tx,
} from '@opensend/db';
import {
  PROVIDER_CAPABILITIES,
  type OutgoingMessage,
  type SubmitResult,
} from '@opensend/providers';
import type { WorkerDeps } from './deps';
import { completeOutbox, postponeOutbox } from './dispatcher';
import { purgeContentIfDue } from './retention';

type EmailRow = typeof emails.$inferSelect;

interface StoredContent {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  replyTo: string[];
}

export type SendOutcome =
  | 'submitted'
  | 'retry_scheduled'
  | 'failed'
  | 'submission_unknown'
  | 'suppressed'
  | 'not_claimable'
  | 'postponed'
  | 'lease_lost';

/**
 * Process one send job:
 *  1. atomically claim it (queued|scheduled|retry_wait -> submitting, with a lease),
 *  2. re-check pause state, suppressions and sender authorization,
 *  3. hand it to the provider once,
 *  4. record the outcome under the lease.
 * A provider timeout after a possible acceptance is `submission_unknown` and is never retried
 * automatically; an expired lease is handled the same way by `reapExpiredLeases`.
 */
export async function processSendEmail(
  deps: WorkerDeps,
  emailId: string,
  outboxId?: number,
): Promise<SendOutcome> {
  const { db, config } = deps;

  const [ctx] = await db
    .select({ project: projects, connection: providerConnections, email: emails })
    .from(emails)
    .innerJoin(projects, eq(projects.id, emails.projectId))
    .leftJoin(providerConnections, eq(providerConnections.id, emails.providerConnectionId))
    .where(eq(emails.id, emailId))
    .limit(1);
  if (!ctx) {
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'not_claimable';
  }
  // Operator pause: keep the job pending and look again later.
  if (ctx.project.pausedAt || ctx.connection?.pausedAt) {
    if (outboxId) await postponeOutbox(deps, outboxId, 300);
    return 'postponed';
  }
  if (
    ctx.email.status === 'scheduled' &&
    ctx.email.scheduledAt &&
    ctx.email.scheduledAt.getTime() > Date.now()
  ) {
    // Never early. (The dispatcher only hands out due rows; this guards against clock skew.)
    if (outboxId)
      await postponeOutbox(
        deps,
        outboxId,
        Math.ceil((ctx.email.scheduledAt.getTime() - Date.now()) / 1000),
      );
    return 'postponed';
  }

  // ---- 1. claim ----------------------------------------------------------------------
  const leaseSeconds = config.OPENSEND_SEND_LEASE_SECONDS;
  const claimed = await db.transaction(async (tx) => {
    const res = await tx.execute<{ attempt_count: number }>(sql`
      UPDATE emails
         SET status = 'submitting',
             attempt_count = attempt_count + 1,
             lease_owner = ${deps.workerId},
             lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
             next_attempt_at = NULL,
             updated_at = now()
       WHERE id = ${emailId}
         AND status IN ('queued', 'scheduled', 'retry_wait')
         AND (scheduled_at IS NULL OR scheduled_at <= now())
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       RETURNING attempt_count`);
    const row = res.rows[0];
    if (!row) return null;
    await tx.insert(sendAttempts).values({
      emailId,
      projectId: ctx.email.projectId,
      attemptNumber: row.attempt_count,
      providerConnectionId: ctx.email.providerConnectionId,
      workerId: deps.workerId,
    });
    return row.attempt_count;
  });
  if (claimed === null) {
    const [current] = await db
      .select({ status: emails.status, nextAttemptAt: emails.nextAttemptAt })
      .from(emails)
      .where(eq(emails.id, emailId));
    // Too early for a retry: leave the outbox row, it will be dispatched when due.
    if (
      current?.status === 'retry_wait' &&
      current.nextAttemptAt &&
      current.nextAttemptAt.getTime() > Date.now()
    ) {
      if (outboxId)
        await postponeOutbox(
          deps,
          outboxId,
          Math.ceil((current.nextAttemptAt.getTime() - Date.now()) / 1000),
        );
      return 'postponed';
    }
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'not_claimable';
  }
  const attempt = claimed;
  const email = { ...ctx.email, attemptCount: attempt };
  const ref = { id: email.id, projectId: email.projectId, environmentId: email.environmentId };

  // ---- 2. pre-flight checks ------------------------------------------------------------
  const pre = await preflight(deps, email);
  if (pre.kind === 'fail') {
    await finishFailure(deps, email, attempt, {
      outcome: 'permanent_failure',
      category: pre.category,
      code: pre.code,
      message: pre.message,
    });
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'failed';
  }
  if (pre.kind === 'all_suppressed') {
    await db.transaction(async (tx) => {
      const ok = await finishUnderLease(tx, deps, email.id, attempt, {
        status: 'suppressed',
        finalizedAt: new Date(),
      });
      if (!ok) return;
      await tx
        .update(sendAttempts)
        .set({ outcome: 'permanent_failure', errorCategory: 'suppressed', finishedAt: new Date() })
        .where(and(eq(sendAttempts.emailId, email.id), eq(sendAttempts.attemptNumber, attempt)));
      await recordEmailEvent(tx, {
        email: ref,
        type: 'email.suppressed',
        source: 'system',
        webhookData: { status: 'suppressed' },
      });
      await purgeContentIfDue(tx, deps, email.id);
    });
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'suppressed';
  }

  // ---- 3. hand-off ----------------------------------------------------------------------
  let result: SubmitResult;
  const adapter = deps.providers({
    type: ctx.connection!.type,
    config: ctx.connection!.config,
    secrets: ctx.connection!.secretCiphertext
      ? deps.keys.decryptJson(
          ctx.connection!.secretCiphertext,
          `provider_connection:${ctx.connection!.id}`,
        )
      : {},
  });
  try {
    result = await adapter.submit(pre.message);
  } catch (err) {
    // An exception we could not classify: we do not know whether the provider accepted it.
    result = {
      outcome: 'unknown',
      category: 'unknown',
      code: 'adapter_exception',
      message: redact((err as Error).message) ?? 'adapter error',
    };
  } finally {
    await adapter.close().catch(() => undefined);
  }

  // ---- 4. record outcome -----------------------------------------------------------------
  let outcome: SendOutcome;
  if (result.outcome === 'accepted')
    outcome = await finishAccepted(deps, email, attempt, result, pre.recipientIds);
  else outcome = await finishFailure(deps, email, attempt, result);
  if (outboxId) await completeOutbox(deps, outboxId);
  if (outcome !== 'lease_lost' && FINAL_STATUSES.includes(outcome as never)) {
    // Attachment objects are deleted after commit (object store is not transactional).
    await deleteDueAttachmentObjects(deps, email.id);
  }
  return outcome;
}

type Preflight =
  | { kind: 'ok'; message: OutgoingMessage; recipientIds: Map<string, string> }
  | { kind: 'all_suppressed' }
  | {
      kind: 'fail';
      category: 'configuration' | 'provider_rejected';
      code: string;
      message: string;
    };

async function preflight(deps: WorkerDeps, email: EmailRow): Promise<Preflight> {
  const { db } = deps;
  const [connection] = email.providerConnectionId
    ? await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, email.providerConnectionId))
    : [];
  if (!connection || !connection.enabled)
    return {
      kind: 'fail',
      category: 'configuration',
      code: 'connection_unavailable',
      message: 'the provider connection was removed or disabled',
    };
  // Sender domain must still be authorized at hand-off time.
  const fromDomain = email.fromAddress.slice(email.fromAddress.lastIndexOf('@') + 1).toLowerCase();
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.environmentId, email.environmentId), eq(domains.name, fromDomain)));
  const authorized =
    domain &&
    (domain.localOnly
      ? connection.type === 'local'
      : Boolean(domain.ownershipVerifiedAt) &&
        (!PROVIDER_CAPABILITIES[connection.type].domainVerification ||
          (domain.providerConnectionId === connection.id && domain.providerStatus === 'verified')));
  if (!authorized)
    return {
      kind: 'fail',
      category: 'configuration',
      code: 'domain_not_verified',
      message: `sender domain ${fromDomain} is no longer authorized`,
    };

  // Suppressions added after acceptance are enforced here too.
  const recipients = await db
    .select()
    .from(emailRecipients)
    .where(and(eq(emailRecipients.emailId, email.id), eq(emailRecipients.status, 'pending')));
  const suppressed = await findSuppressed(
    db,
    email.environmentId,
    recipients.map((r) => r.address),
  );
  if (suppressed.size > 0) {
    await db.transaction(async (tx) => {
      for (const r of recipients.filter((x) => suppressed.has(x.address.toLowerCase()))) {
        await tx
          .update(emailRecipients)
          .set({ status: 'suppressed', statusDetail: suppressed.get(r.address.toLowerCase()) })
          .where(eq(emailRecipients.id, r.id));
        await recordEmailEvent(tx, {
          email: { id: email.id, projectId: email.projectId, environmentId: email.environmentId },
          type: 'recipient.suppressed',
          source: 'system',
          recipient: { id: r.id, address: r.address },
          data: { reason: suppressed.get(r.address.toLowerCase()), stage: 'pre_submission' },
        });
      }
    });
  }
  const deliverable = recipients.filter((r) => !suppressed.has(r.address.toLowerCase()));
  if (deliverable.length === 0) return { kind: 'all_suppressed' };

  const [c] = await db.select().from(emailContents).where(eq(emailContents.emailId, email.id));
  if (!c)
    return {
      kind: 'fail',
      category: 'configuration',
      code: 'content_missing',
      message: 'message content is no longer available',
    };
  const content = deps.keys.decryptJson<StoredContent>(c.ciphertext, `email_content:${email.id}`);
  const files = await db
    .select()
    .from(emailAttachments)
    .where(and(eq(emailAttachments.emailId, email.id), isNull(emailAttachments.purgedAt)));
  const attachments = await Promise.all(
    files.map(async (f) => ({
      filename: f.filename,
      contentType: f.contentType,
      contentId: f.contentId ?? undefined,
      content: await getDecrypted(deps.store, deps.keys, f.objectKey),
    })),
  );
  const byKind = (k: 'to' | 'cc' | 'bcc') =>
    deliverable.filter((r) => r.kind === k).map((r) => r.address);
  return {
    kind: 'ok',
    recipientIds: new Map(deliverable.map((r) => [r.address.toLowerCase(), r.id])),
    message: {
      messageId: email.messageIdHeader,
      from: { email: email.fromAddress, name: email.fromName ?? undefined },
      to: byKind('to'),
      cc: byKind('cc'),
      bcc: byKind('bcc'),
      replyTo: content.replyTo,
      subject: email.subject ?? '',
      html: content.html,
      text: content.text,
      headers: { ...content.headers, 'X-OpenSend-Email-Id': email.id },
      attachments,
      tags: email.tags as Record<string, string>,
    },
  };
}

/** Conditional update that only succeeds while we still own the attempt. */
async function finishUnderLease(
  tx: Tx,
  deps: WorkerDeps,
  emailId: string,
  attempt: number,
  patch: Partial<typeof emails.$inferInsert>,
  allowFromUnknown = false,
): Promise<boolean> {
  const rows = await tx
    .update(emails)
    .set({ ...patch, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(emails.id, emailId),
        eq(emails.attemptCount, attempt),
        allowFromUnknown
          ? sql`(${emails.status} = 'submitting' AND ${emails.leaseOwner} = ${deps.workerId} OR ${emails.status} = 'submission_unknown')`
          : and(eq(emails.status, 'submitting'), eq(emails.leaseOwner, deps.workerId)),
      ),
    )
    .returning({ id: emails.id });
  return rows.length > 0;
}

async function finishAccepted(
  deps: WorkerDeps,
  email: EmailRow,
  attempt: number,
  result: Extract<SubmitResult, { outcome: 'accepted' }>,
  recipientIds: Map<string, string>,
): Promise<SendOutcome> {
  const ref = { id: email.id, projectId: email.projectId, environmentId: email.environmentId };
  const now = new Date();
  return deps.db.transaction(async (tx) => {
    await tx
      .update(sendAttempts)
      .set({
        outcome: 'accepted',
        providerMessageId: result.providerMessageId,
        providerResponse: result.response ?? null,
        finishedAt: now,
      })
      .where(and(eq(sendAttempts.emailId, email.id), eq(sendAttempts.attemptNumber, attempt)));
    // Even if the lease expired meanwhile (status moved to submission_unknown), a confirmed
    // acceptance resolves it to submitted.
    const ok = await finishUnderLease(
      tx,
      deps,
      email.id,
      attempt,
      {
        status: 'submitted',
        providerMessageId: result.providerMessageId,
        submittedAt: now,
        finalizedAt: now,
        failureCategory: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      true,
    );
    if (!ok) return 'lease_lost';
    const rejected = new Map(
      result.rejectedRecipients.map((r) => [r.address.toLowerCase(), r.reason]),
    );
    for (const [address, id] of recipientIds) {
      if (rejected.has(address)) {
        await tx
          .update(emailRecipients)
          .set({ status: 'rejected', statusDetail: redact(rejected.get(address), 200) })
          .where(eq(emailRecipients.id, id));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.rejected',
          source: 'provider',
          recipient: { id, address },
          data: { reason: redact(rejected.get(address), 200) },
        });
      } else {
        await tx
          .update(emailRecipients)
          .set({ status: 'submitted' })
          .where(eq(emailRecipients.id, id));
      }
    }
    await recordEmailEvent(tx, {
      email: ref,
      type: 'email.submitted',
      source: 'system',
      occurredAt: now,
      data: {
        attempt,
        providerMessageId: result.providerMessageId,
        accepted: result.acceptedRecipients.length,
        rejected: result.rejectedRecipients.length,
      },
      webhookData: { status: 'submitted', tags: email.tags },
    });
    await purgeContentIfDue(tx, deps, email.id);
    return 'submitted';
  });
}

async function finishFailure(
  deps: WorkerDeps,
  email: EmailRow,
  attempt: number,
  result: Exclude<SubmitResult, { outcome: 'accepted' }>,
): Promise<SendOutcome> {
  const ref = { id: email.id, projectId: email.projectId, environmentId: email.environmentId };
  const now = new Date();
  const maxAttempts = deps.config.OPENSEND_MAX_SEND_ATTEMPTS;
  return deps.db.transaction(async (tx) => {
    await tx
      .update(sendAttempts)
      .set({
        outcome: result.outcome,
        errorCategory: result.category,
        errorCode: result.code,
        errorMessage: redact(result.message),
        finishedAt: now,
      })
      .where(and(eq(sendAttempts.emailId, email.id), eq(sendAttempts.attemptNumber, attempt)));
    const errorFields = {
      failureCategory: result.category,
      lastErrorCode: result.code,
      lastErrorMessage: redact(result.message),
    };

    if (result.outcome === 'transient_failure' && attempt < maxAttempts) {
      const next = new Date(
        now.getTime() + backoffDelayMs(attempt, { baseMs: 30_000, maxMs: 60 * 60_000 }),
      );
      const ok = await finishUnderLease(tx, deps, email.id, attempt, {
        status: 'retry_wait',
        nextAttemptAt: next,
        ...errorFields,
      });
      if (!ok) return 'lease_lost';
      await enqueueOutbox(tx, {
        kind: 'send_email',
        refId: email.id,
        projectId: email.projectId,
        availableAt: next,
      });
      await recordEmailEvent(tx, {
        email: ref,
        type: 'email.retry_scheduled',
        source: 'system',
        data: {
          attempt,
          nextAttemptAt: next.toISOString(),
          category: result.category,
          code: result.code,
        },
      });
      return 'retry_scheduled';
    }

    if (result.outcome === 'unknown') {
      const ok = await finishUnderLease(tx, deps, email.id, attempt, {
        status: 'submission_unknown',
        finalizedAt: now,
        ...errorFields,
      });
      if (!ok) return 'lease_lost';
      await tx
        .update(emailRecipients)
        .set({ status: 'unknown' })
        .where(and(eq(emailRecipients.emailId, email.id), eq(emailRecipients.status, 'pending')));
      await recordEmailEvent(tx, {
        email: ref,
        type: 'email.submission_unknown',
        source: 'system',
        data: {
          attempt,
          category: result.category,
          code: result.code,
          note: 'not retried automatically to avoid duplicates',
        },
        webhookData: { status: 'submission_unknown' },
      });
      return 'submission_unknown';
    }

    // permanent failure, or transient failure with attempts exhausted
    const ok = await finishUnderLease(tx, deps, email.id, attempt, {
      status: 'failed',
      finalizedAt: now,
      ...errorFields,
    });
    if (!ok) return 'lease_lost';
    const rejected = new Set(
      ('rejectedRecipients' in result ? (result.rejectedRecipients ?? []) : []).map((r) =>
        r.address.toLowerCase(),
      ),
    );
    const pending = await tx
      .select()
      .from(emailRecipients)
      .where(and(eq(emailRecipients.emailId, email.id), eq(emailRecipients.status, 'pending')));
    for (const r of pending) {
      const isRejected = rejected.has(r.address.toLowerCase());
      await tx
        .update(emailRecipients)
        .set({
          status: isRejected ? 'rejected' : 'failed',
          statusDetail: redact(result.message, 200),
        })
        .where(eq(emailRecipients.id, r.id));
      if (isRejected)
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.rejected',
          source: 'provider',
          recipient: { id: r.id, address: r.address },
          data: { code: result.code },
        });
    }
    await recordEmailEvent(tx, {
      email: ref,
      type: 'email.failed',
      source: 'system',
      data: {
        attempt,
        category: result.category,
        code: result.code,
        exhausted: result.outcome === 'transient_failure',
      },
      webhookData: { status: 'failed', category: result.category, code: result.code },
    });
    await purgeContentIfDue(tx, deps, email.id);
    return 'failed';
  });
}

async function deleteDueAttachmentObjects(deps: WorkerDeps, emailId: string): Promise<void> {
  const rows = await deps.db.execute<{ id: string; object_key: string }>(sql`
    SELECT a.id, a.object_key FROM email_attachments a
      JOIN emails e ON e.id = a.email_id
      JOIN projects p ON p.id = e.project_id
     WHERE a.email_id = ${emailId} AND a.purged_at IS NULL
       AND p.attachment_retention_days = 0
       AND e.status IN ('submitted', 'failed', 'cancelled', 'suppressed')`);
  for (const r of rows.rows) {
    try {
      await deps.store.delete(r.object_key);
      await deps.db
        .update(emailAttachments)
        .set({ purgedAt: new Date() })
        .where(eq(emailAttachments.id, r.id));
    } catch (err) {
      deps.logger.warn(
        { err: (err as Error).message, attachmentId: r.id },
        'attachment purge failed; retention job will retry',
      );
    }
  }
}
