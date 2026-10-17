import { z } from 'zod';

/** Stable machine-readable error codes. HTTP status is part of the contract. */
export const ERROR_CODES = {
  validation_error: 422,
  invalid_request: 400,
  unauthorized: 401,
  invalid_api_key: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  not_cancellable: 409,
  domain_not_verified: 422,
  provider_unavailable: 422,
  recipients_suppressed: 422,
  payload_too_large: 413,
  quota_exceeded: 429,
  backlog_limit_exceeded: 429,
  rate_limited: 429,
  project_paused: 423,
  setup_required: 409,
  internal_error: 500,
  service_unavailable: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
