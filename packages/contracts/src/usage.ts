import { z } from 'zod';

export const usageResponseSchema = z.object({
  object: z.literal('usage'),
  period: z.string(),
  acceptedEmails: z.number(),
  acceptedRecipients: z.number(),
  quota: z.object({ recipients: z.number(), remaining: z.number() }),
  pending: z.number(),
  limits: z.object({
    maxRecipientsPerEmail: z.number(),
    maxAttachmentBytes: z.number(),
    maxScheduleDays: z.number(),
    maxBatchSize: z.number(),
    maxPendingPerEnvironment: z.number(),
    rateLimitPerMinute: z.number(),
  }),
});
export type UsageResponse = z.infer<typeof usageResponseSchema>;
