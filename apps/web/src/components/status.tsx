import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground border-border',
  info: 'bg-info-soft text-info border-info/20',
  success: 'bg-success-soft text-success border-success/20',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-destructive border-destructive/20',
};

/**
 * Wording is deliberate: "Submitted" means the transport accepted the message — it is not a
 * delivery confirmation. "Delivered" only appears when a provider delivery event exists.
 */
const EMAIL_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  accepted: { label: 'Accepted', tone: 'neutral', hint: 'Durably accepted, not yet queued' },
  scheduled: { label: 'Scheduled', tone: 'info', hint: 'Waiting for its scheduled time' },
  queued: { label: 'Queued', tone: 'info', hint: 'Waiting for a worker' },
  submitting: { label: 'Submitting', tone: 'info', hint: 'Being handed to the provider' },
  retry_wait: {
    label: 'Retrying',
    tone: 'warning',
    hint: 'Hand-off failed temporarily; another attempt is scheduled',
  },
  submitted: {
    label: 'Submitted',
    tone: 'neutral',
    hint: 'Accepted by the configured transport. Not a delivery confirmation.',
  },
  delivered: {
    label: 'Delivered',
    tone: 'success',
    hint: 'The provider reported delivery for every submitted recipient',
  },
  partially_delivered: {
    label: 'Partly delivered',
    tone: 'success',
    hint: 'Delivery reported for some recipients',
  },
  bounced: {
    label: 'Bounced',
    tone: 'danger',
    hint: 'The provider reported a bounce for every submitted recipient',
  },
  partially_bounced: { label: 'Partly bounced', tone: 'warning', hint: 'Some recipients bounced' },
  complained: { label: 'Complaint', tone: 'danger', hint: 'A recipient marked this email as spam' },
  failed: { label: 'Failed', tone: 'danger', hint: 'The provider did not accept the email' },
  submission_unknown: {
    label: 'Outcome unknown',
    tone: 'warning',
    hint: 'The provider may or may not have accepted it. Not retried automatically.',
  },
  cancelled: { label: 'Cancelled', tone: 'neutral', hint: 'Cancelled before hand-off' },
  suppressed: {
    label: 'Suppressed',
    tone: 'neutral',
    hint: 'All recipients are on a suppression list',
  },
};

export function Pill({
  tone = 'neutral',
  children,
  title,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px text-[12px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmailStatus({ status }: { status: string }) {
  const s = EMAIL_STATUS[status] ?? { label: status, tone: 'neutral' as Tone, hint: '' };
  return (
    <Pill tone={s.tone} title={s.hint}>
      {s.label}
    </Pill>
  );
}

export function emailStatusHint(status: string): string {
  return EMAIL_STATUS[status]?.hint ?? '';
}

const RECIPIENT: Record<string, Tone> = {
  pending: 'info',
  submitted: 'neutral',
  suppressed: 'neutral',
  rejected: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
  unknown: 'warning',
};
export function RecipientStatus({ status }: { status: string }) {
  return <Pill tone={RECIPIENT[status] ?? 'neutral'}>{status.replace('_', ' ')}</Pill>;
}

export function EnvBadge({ kind, name }: { kind: string; name?: string }) {
  const tone: Tone = kind === 'production' ? 'danger' : kind === 'staging' ? 'warning' : 'info';
  return (
    <Pill tone={tone} title={`${kind} environment`}>
      {name ?? kind}
    </Pill>
  );
}
