import { z } from 'zod';

/** Lifecycle events delivered to webhook endpoints (version 1). */
export const WEBHOOK_EVENT_TYPES = [
  'email.scheduled',
  'email.submitted',
  'email.failed',
  'email.submission_unknown',
  'email.cancelled',
  'email.suppressed',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.delivery_delayed',
  'email.recipient_rejected',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const webhookEventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  version: z.literal(1),
  createdAt: z.string(),
  projectId: z.uuid(),
  environmentId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEventEnvelope = z.infer<typeof webhookEventEnvelopeSchema>;

export const createWebhookRequestSchema = z.object({
  url: z.url().max(2048),
  description: z.string().max(200).optional(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

/** Header names used on outgoing webhook requests. */
export const WEBHOOK_HEADERS = {
  id: 'opensend-webhook-id',
  timestamp: 'opensend-webhook-timestamp',
  signature: 'opensend-webhook-signature',
} as const;
