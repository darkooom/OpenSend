import { addSuppression, recordEmailEvent } from '@opensend/core';
import { and, emailRecipients, emails, eq, providerEvents, sql } from '@opensend/db';
import type { WorkerDeps } from './deps';
import { completeOutbox } from './dispatcher';

type Recipient = {
  address: string;
  detail?: string;
  bounceType?: 'permanent' | 'transient' | 'undetermined';
};

export type ProviderEventOutcome = 'matched' | 'unmatched' | 'ignored' | 'already_processed';

/**
 * Applies a stored provider notification to the matching email. Matching is restricted to
 * emails sent through the SAME provider connection that received the event, so a tenant's
 * SNS topic can never touch another tenant's emails. Unmatched events stay stored and are
 * retried by `reconcileProviderEvents` (they may arrive before we recorded the message id).
 */
export async function processProviderEvent(
  deps: WorkerDeps,
  providerEventId: string,
  outboxId?: number,
): Promise<ProviderEventOutcome> {
  const outcome = await deps.db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.id, providerEventId))
      .for('update');
    if (!ev) return 'ignored' as const;
    if (ev.matchStatus === 'matched' || ev.matchStatus === 'ignored')
      return 'already_processed' as const;
    if (!ev.providerMessageId || !ev.providerConnectionId) {
      await tx
        .update(providerEvents)
        .set({ matchStatus: 'ignored', processedAt: new Date() })
        .where(eq(providerEvents.id, ev.id));
      return 'ignored' as const;
    }
    const [email] = await tx
      .select()
      .from(emails)
      .where(
        and(
          eq(emails.providerMessageId, ev.providerMessageId),
          eq(emails.providerConnectionId, ev.providerConnectionId),
        ),
      )
      .limit(1);
    if (!email) {
      await tx
        .update(providerEvents)
        .set({ matchStatus: 'unmatched', matchAttempts: sql`${providerEvents.matchAttempts} + 1` })
        .where(eq(providerEvents.id, ev.id));
      return 'unmatched' as const;
    }

    const ref = { id: email.id, projectId: email.projectId, environmentId: email.environmentId };
    const payload = ev.payload as { recipients?: Recipient[] };
    const occurredAt = ev.occurredAt ?? ev.receivedAt;
    const recipients = await tx
      .select()
      .from(emailRecipients)
      .where(eq(emailRecipients.emailId, email.id));
    const byAddress = new Map(recipients.map((r) => [r.address.toLowerCase(), r]));

    for (const er of payload.recipients ?? []) {
      const r = byAddress.get(er.address.toLowerCase());
      if (!r) continue; // provider reported an address we did not send to: kept in provider_events only
      // Each delivery fact is kept independently; later events never erase earlier ones.
      if (ev.eventType === 'delivered') {
        await tx
          .update(emailRecipients)
          .set({
            deliveredAt: sql`COALESCE(${emailRecipients.deliveredAt}, ${occurredAt})`,
            lastEventAt: occurredAt,
          })
          .where(eq(emailRecipients.id, r.id));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.delivered',
          source: 'provider',
          recipient: { id: r.id, address: r.address },
          occurredAt,
          providerEventId: ev.id,
          webhookData: { tags: email.tags },
        });
      } else if (ev.eventType === 'bounced') {
        await tx
          .update(emailRecipients)
          .set({
            bouncedAt: sql`COALESCE(${emailRecipients.bouncedAt}, ${occurredAt})`,
            bounceType: er.bounceType ?? null,
            lastEventAt: occurredAt,
          })
          .where(eq(emailRecipients.id, r.id));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.bounced',
          source: 'provider',
          recipient: { id: r.id, address: r.address },
          occurredAt,
          providerEventId: ev.id,
          data: { bounceType: er.bounceType, detail: er.detail },
          webhookData: { bounceType: er.bounceType, tags: email.tags },
        });
        if (er.bounceType === 'permanent') {
          await addSuppression(tx, {
            projectId: email.projectId,
            environmentId: email.environmentId,
            address: r.address,
            reason: 'hard_bounce',
            sourceEmailId: email.id,
          });
        }
      } else if (ev.eventType === 'complained') {
        await tx
          .update(emailRecipients)
          .set({
            complainedAt: sql`COALESCE(${emailRecipients.complainedAt}, ${occurredAt})`,
            lastEventAt: occurredAt,
          })
          .where(eq(emailRecipients.id, r.id));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.complained',
          source: 'provider',
          recipient: { id: r.id, address: r.address },
          occurredAt,
          providerEventId: ev.id,
          webhookData: { tags: email.tags },
        });
        await addSuppression(tx, {
          projectId: email.projectId,
          environmentId: email.environmentId,
          address: r.address,
          reason: 'complaint',
          sourceEmailId: email.id,
        });
      } else if (ev.eventType === 'deferred') {
        await tx
          .update(emailRecipients)
          .set({ deferredAt: occurredAt, lastEventAt: occurredAt })
          .where(eq(emailRecipients.id, r.id));
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.deferred',
          source: 'provider',
          recipient: { id: r.id, address: r.address },
          occurredAt,
          providerEventId: ev.id,
          data: { detail: er.detail },
        });
      } else if (ev.eventType === 'rejected') {
        await recordEmailEvent(tx, {
          email: ref,
          type: 'recipient.rejected',
          source: 'provider',
          recipient: { id: r.id, address: r.address },
          occurredAt,
          providerEventId: ev.id,
          data: { detail: er.detail },
        });
      }
    }
    await tx
      .update(providerEvents)
      .set({
        matchStatus: 'matched',
        projectId: email.projectId,
        emailId: email.id,
        processedAt: new Date(),
        matchAttempts: sql`${providerEvents.matchAttempts} + 1`,
      })
      .where(eq(providerEvents.id, ev.id));
    return 'matched' as const;
  });
  if (outboxId) await completeOutbox(deps, outboxId);
  return outcome;
}

/** Retry matching for events that arrived before their email was marked as submitted. */
export async function reconcileProviderEvents(deps: WorkerDeps): Promise<number> {
  const rows = await deps.db.execute<{ id: string }>(sql`
    SELECT id FROM provider_events
     WHERE match_status IN ('pending', 'unmatched') AND received_at > now() - interval '7 days' AND match_attempts < 50
     ORDER BY received_at LIMIT 200`);
  let matched = 0;
  for (const r of rows.rows) if ((await processProviderEvent(deps, r.id)) === 'matched') matched++;
  return matched;
}
