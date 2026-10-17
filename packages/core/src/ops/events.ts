import {
  and,
  emailEvents,
  eq,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type DbOrTx,
} from '@opensend/db';
import type { WebhookEventType } from '@opensend/contracts';
import { enqueueOutbox } from './outbox';

export type LifecycleEventType =
  | 'email.accepted'
  | 'email.scheduled'
  | 'email.queued'
  | 'email.submitting'
  | 'email.submitted'
  | 'email.retry_scheduled'
  | 'email.failed'
  | 'email.submission_unknown'
  | 'email.cancelled'
  | 'email.suppressed'
  | 'email.resent'
  | 'email.content_purged'
  | 'recipient.suppressed'
  | 'recipient.rejected'
  | 'recipient.delivered'
  | 'recipient.bounced'
  | 'recipient.complained'
  | 'recipient.deferred';

const WEBHOOK_MAPPING: Partial<Record<LifecycleEventType, WebhookEventType>> = {
  'email.scheduled': 'email.scheduled',
  'email.submitted': 'email.submitted',
  'email.failed': 'email.failed',
  'email.submission_unknown': 'email.submission_unknown',
  'email.cancelled': 'email.cancelled',
  'email.suppressed': 'email.suppressed',
  'recipient.delivered': 'email.delivered',
  'recipient.bounced': 'email.bounced',
  'recipient.complained': 'email.complained',
  'recipient.deferred': 'email.delivery_delayed',
  'recipient.rejected': 'email.recipient_rejected',
};

export interface EmailRef {
  id: string;
  projectId: string;
  environmentId: string;
}

export interface RecordEventInput {
  email: EmailRef;
  type: LifecycleEventType;
  source: 'system' | 'provider' | 'user' | 'operator';
  recipient?: { id: string; address: string };
  occurredAt?: Date;
  providerEventId?: string;
  /** Non-sensitive metadata only (no content, no credentials). */
  data?: Record<string, unknown>;
  /** Extra fields exposed in the webhook payload. */
  webhookData?: Record<string, unknown>;
}

/**
 * Append a lifecycle event and fan it out to matching webhook endpoints, all within the
 * caller's transaction. Returns false when the event was a duplicate (same provider event).
 */
export async function recordEmailEvent(tx: DbOrTx, input: RecordEventInput): Promise<boolean> {
  const occurredAt = input.occurredAt ?? new Date();
  const inserted = await tx
    .insert(emailEvents)
    .values({
      emailId: input.email.id,
      recipientId: input.recipient?.id ?? null,
      projectId: input.email.projectId,
      environmentId: input.email.environmentId,
      type: input.type,
      source: input.source,
      providerEventId: input.providerEventId ?? null,
      data: input.data ?? {},
      occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: emailEvents.id });
  if (inserted.length === 0) return false;

  const webhookType = WEBHOOK_MAPPING[input.type];
  if (webhookType) {
    await emitWebhookEvent(tx, {
      projectId: input.email.projectId,
      environmentId: input.email.environmentId,
      type: webhookType,
      emailId: input.email.id,
      occurredAt,
      data: {
        emailId: input.email.id,
        ...(input.recipient ? { recipient: input.recipient.address } : {}),
        ...(input.webhookData ?? {}),
      },
    });
  }
  return true;
}

export async function emitWebhookEvent(
  tx: DbOrTx,
  input: {
    projectId: string;
    environmentId: string;
    type: string;
    emailId?: string;
    occurredAt: Date;
    data: Record<string, unknown>;
  },
): Promise<string | null> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, eventTypes: webhookEndpoints.eventTypes })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.projectId, input.projectId),
        eq(webhookEndpoints.environmentId, input.environmentId),
        eq(webhookEndpoints.enabled, true),
      ),
    );
  const targets = endpoints.filter((e) => e.eventTypes.includes(input.type));
  if (targets.length === 0) return null;

  const [event] = await tx
    .insert(webhookEvents)
    .values({
      projectId: input.projectId,
      environmentId: input.environmentId,
      type: input.type,
      version: 1,
      emailId: input.emailId ?? null,
      occurredAt: input.occurredAt,
      payload: input.data,
    })
    .returning({ id: webhookEvents.id });

  for (const target of targets) {
    const [delivery] = await tx
      .insert(webhookDeliveries)
      .values({ webhookEventId: event!.id, endpointId: target.id, projectId: input.projectId })
      .returning({ id: webhookDeliveries.id });
    await enqueueOutbox(tx, {
      kind: 'deliver_webhook',
      refId: delivery!.id,
      projectId: input.projectId,
    });
  }
  return event!.id;
}
