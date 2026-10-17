/**
 * Send-job state machine. This is the single definition used by the API, the worker,
 * the dashboard and the documentation generator.
 *
 *   accepted ──► queued ──► submitting ──► submitted
 *      │           ▲  │          │
 *      ▼           │  ▼          ├──► retry_wait ──► submitting (next attempt)
 *   scheduled ─────┘ suppressed  ├──► failed
 *      │                         └──► submission_unknown
 *      ▼
 *   cancelled  (from accepted / scheduled / queued / retry_wait only)
 *
 * `submitted` only means the configured transport accepted the message. Delivery facts
 * (delivered / bounced / complained) are tracked per recipient from provider events.
 */
export const EMAIL_STATUS = [
  'accepted',
  'scheduled',
  'queued',
  'submitting',
  'retry_wait',
  'submitted',
  'failed',
  'submission_unknown',
  'cancelled',
  'suppressed',
] as const;
export type EmailStatus = (typeof EMAIL_STATUS)[number];

export const EMAIL_TRANSITIONS: Readonly<Record<EmailStatus, readonly EmailStatus[]>> = {
  accepted: ['queued', 'scheduled', 'cancelled', 'suppressed'],
  scheduled: ['queued', 'cancelled'],
  queued: ['submitting', 'cancelled', 'suppressed'],
  submitting: ['submitted', 'retry_wait', 'failed', 'submission_unknown', 'suppressed'],
  retry_wait: ['submitting', 'cancelled', 'failed'],
  submitted: [],
  failed: [],
  // An operator/user may resolve an unknown outcome once the provider confirms it.
  submission_unknown: ['submitted', 'failed'],
  cancelled: [],
  suppressed: [],
};

/** States from which a worker may claim the job for a submission attempt. */
export const CLAIMABLE_STATUSES: readonly EmailStatus[] = ['queued', 'scheduled', 'retry_wait'];
/** States in which cancellation is still possible (no hand-off has started). */
export const CANCELLABLE_STATUSES: readonly EmailStatus[] = [
  'accepted',
  'scheduled',
  'queued',
  'retry_wait',
];
/** States that end the submission lifecycle. */
export const FINAL_STATUSES: readonly EmailStatus[] = [
  'submitted',
  'failed',
  'submission_unknown',
  'cancelled',
  'suppressed',
];
/** States still counting toward the per-environment pending backlog. */
export const PENDING_STATUSES: readonly EmailStatus[] = [
  'accepted',
  'scheduled',
  'queued',
  'submitting',
  'retry_wait',
];

export function canTransition(from: EmailStatus, to: EmailStatus): boolean {
  return EMAIL_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: EmailStatus,
    readonly to: EmailStatus,
  ) {
    super(`Invalid email status transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: EmailStatus, to: EmailStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** All states that may legally move to `to` – used to build atomic conditional UPDATEs. */
export function sourcesFor(to: EmailStatus): EmailStatus[] {
  return EMAIL_STATUS.filter((s) => EMAIL_TRANSITIONS[s].includes(to));
}

/** Submission-side state of a single recipient. */
export const RECIPIENT_STATUS = [
  'pending',
  'suppressed',
  'submitted',
  'rejected',
  'failed',
  'cancelled',
  'unknown',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUS)[number];

export interface RecipientDeliveryFacts {
  status: RecipientStatus;
  deliveredAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  deferredAt?: string | null;
}

export interface RecipientSummary {
  total: number;
  pending: number;
  suppressed: number;
  submitted: number;
  rejected: number;
  failed: number;
  cancelled: number;
  unknown: number;
  delivered: number;
  bounced: number;
  complained: number;
}

/**
 * Aggregation used by list views. Counts are independent: a recipient that was delivered
 * and later complained counts in both `delivered` and `complained`.
 */
export function summarizeRecipients(recipients: RecipientDeliveryFacts[]): RecipientSummary {
  const s: RecipientSummary = {
    total: recipients.length,
    pending: 0,
    suppressed: 0,
    submitted: 0,
    rejected: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
  };
  for (const r of recipients) {
    s[r.status] += 1;
    if (r.deliveredAt) s.delivered += 1;
    if (r.bouncedAt) s.bounced += 1;
    if (r.complainedAt) s.complained += 1;
  }
  return s;
}

/**
 * Short label for list views. It never claims more than the facts support:
 * "partially_delivered" when some but not all submitted recipients have a delivery event, etc.
 */
export type DisplayStatus =
  | EmailStatus
  | 'delivered'
  | 'partially_delivered'
  | 'bounced'
  | 'partially_bounced'
  | 'complained';

export function displayStatus(status: EmailStatus, summary: RecipientSummary): DisplayStatus {
  if (status !== 'submitted') return status;
  const reached = summary.submitted;
  if (reached === 0) return status;
  if (summary.complained > 0) return 'complained';
  if (summary.bounced === reached) return 'bounced';
  if (summary.bounced > 0) return 'partially_bounced';
  if (summary.delivered === reached && summary.rejected === 0) return 'delivered';
  if (summary.delivered > 0) return 'partially_delivered';
  return 'submitted';
}
