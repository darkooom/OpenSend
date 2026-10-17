'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field, FormError } from '@/components/auth-card';
import { ErrorState, LoadingRows, PageHeader, Section } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { relative } from '@/lib/format';
import { useApi, useEnvScope, useProject } from '@/lib/hooks';
import type { DomainResource, UsageResponse } from '@/lib/types';

interface Overview {
  last24h: {
    accepted: number;
    submitted: number;
    failed: number;
    delivered: number;
    bounced: number;
    complained: number;
  };
  pending: number;
  scheduled: number;
  submissionUnknown: number;
  oldestPendingAt: string | null;
  webhooks: { dead: number; backlog: number };
  daily: Array<{ day: string; accepted: number; failed: number }>;
  usage: UsageResponse;
  warnings: Array<{ level: 'warning' | 'error'; message: string }>;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'danger' | 'warning';
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 font-mono text-[22px] font-medium tabular-nums ${tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : ''}`}
      >
        {value}
      </p>
      {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Onboarding({ base, href }: { base: string; href: (p: string) => string }) {
  const providers = useApi<{ data: unknown[] }>(`${base}/providers`);
  const domains = useApi<DomainResource[]>(`${base}/domains`);
  const keys = useApi<Array<{ active: boolean }>>(`${base}/api-keys`);
  const emails = useApi<{ data: unknown[] }>(`${base}/emails?limit=1`);
  if (providers.isLoading || domains.isLoading) return null;
  const steps = [
    {
      done: (providers.data?.data.length ?? 0) > 0,
      label: 'Connect a sending provider',
      link: href('/providers'),
    },
    {
      done: (domains.data ?? []).some((d) => d.canSend),
      label: 'Add a sender domain that can send',
      link: href('/domains'),
    },
    {
      done: (keys.data ?? []).some((k) => k.active),
      label: 'Create an API key',
      link: href('/api-keys'),
    },
    { done: (emails.data?.data.length ?? 0) > 0, label: 'Send a first email', link: '#test-send' },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <Section title="Getting started" description="Four steps until this environment sends email.">
      <ol className="grid gap-px overflow-hidden rounded-md border bg-border md:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.label} className="bg-card px-4 py-3">
            <Link href={s.link} className="flex items-start gap-2 hover:text-primary">
              {s.done ? (
                <CheckCircle2 className="mt-0.5 size-4 text-success" />
              ) : (
                <Circle className="mt-0.5 size-4 text-muted-foreground" />
              )}
              <span>
                <span className="text-muted-foreground">{i + 1}. </span>
                {s.label}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function TestSend({
  base,
  href,
  domains,
}: {
  base: string;
  href: (p: string) => string;
  domains: DomainResource[];
}) {
  const sendable = domains.filter((d) => d.canSend);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (sendable.length === 0) {
    return (
      <p className="text-muted-foreground">
        No domain in this environment can send yet.{' '}
        <Link className="text-primary underline" href={href('/domains')}>
          Add or verify a domain
        </Link>{' '}
        to try a test email.
      </p>
    );
  }
  return (
    <form
      id="test-send"
      className="grid gap-3 rounded-md border bg-card p-4 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError(null);
        try {
          const r = await api<{ id: string }>(`${base}/test-email`, {
            method: 'POST',
            body: {
              from: `${f.get('localpart')}@${f.get('domain')}`,
              to: f.get('to'),
              subject: f.get('subject'),
              text: 'This is a test email sent from the OpenSend dashboard.',
              html: '<p>This is a test email sent from the <strong>OpenSend</strong> dashboard.</p>',
              tags: { source: 'dashboard-test' },
            },
          });
          toast.success('Test email accepted', {
            description: 'Accepted for sending. Follow its progress in Emails.',
            action: { label: 'Open', onClick: () => (location.href = href(`/emails/${r.id}`)) },
          });
        } catch (err) {
          setError(errorMessage(err, 'The test email was not accepted.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field id="ts-from" label="From">
        <div className="flex items-center gap-1">
          <Input id="ts-from" name="localpart" defaultValue="hello" required className="w-24" />
          <span>@</span>
          <select
            name="domain"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-card px-2"
            aria-label="Sender domain"
          >
            {sendable.map((d) => (
              <option key={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </Field>
      <Field id="ts-to" label="To">
        <Input id="ts-to" name="to" type="email" required placeholder="you@example.test" />
      </Field>
      <Field id="ts-subject" label="Subject">
        <Input id="ts-subject" name="subject" defaultValue="OpenSend test" required />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send test'}
      </Button>
      <div className="md:col-span-4">
        <FormError message={error} />
      </div>
    </form>
  );
}

export default function OverviewPage() {
  const { base, projectId, envId } = useEnvScope();
  const href = (p: string) => `/p/${projectId}/e/${envId}${p}`;
  const project = useProject(projectId);
  const overview = useApi<Overview>(`${base}/overview`, { refetchInterval: 15_000 });
  const domains = useApi<DomainResource[]>(`${base}/domains`);
  const env = project.data?.environments.find((e) => e.id === envId);
  const o = overview.data;
  return (
    <>
      <PageHeader
        title="Overview"
        description={env ? `${project.data?.name} · ${env.name}` : undefined}
      />
      {overview.isLoading ? (
        <LoadingRows rows={2} cols={4} />
      ) : overview.error || !o ? (
        <ErrorState
          error={overview.error}
          what="the overview"
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <>
          {o.warnings.length > 0 && (
            <ul className="mb-6 grid gap-1.5">
              {o.warnings.map((w) => (
                <li
                  key={w.message}
                  className={`rounded-md border px-3 py-2 ${w.level === 'error' ? 'border-destructive/30 bg-danger-soft text-destructive' : 'border-warning/30 bg-warning-soft text-warning'}`}
                >
                  {w.message}
                </li>
              ))}
            </ul>
          )}
          <Onboarding base={base} href={href} />
          <Section
            title="Last 24 hours"
            description="Submitted means the provider accepted it. Delivered, bounced and complaints only come from provider events (not available for SMTP relays or the local provider)."
          >
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-6">
              <Stat label="Accepted" value={o.last24h.accepted} />
              <Stat label="Submitted" value={o.last24h.submitted} />
              <Stat
                label="Failed"
                value={o.last24h.failed}
                tone={o.last24h.failed ? 'danger' : undefined}
              />
              <Stat label="Delivered" value={o.last24h.delivered} />
              <Stat
                label="Bounced"
                value={o.last24h.bounced}
                tone={o.last24h.bounced ? 'warning' : undefined}
              />
              <Stat
                label="Complaints"
                value={o.last24h.complained}
                tone={o.last24h.complained ? 'danger' : undefined}
              />
            </div>
          </Section>
          <Section title="Pending work">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 md:[&>*:last-child:nth-child(odd)]:col-span-1">
              <Stat
                label="Pending"
                value={o.pending}
                hint={o.oldestPendingAt ? `oldest ${relative(o.oldestPendingAt)}` : undefined}
              />
              <Stat label="Scheduled" value={o.scheduled} />
              <Stat
                label="Outcome unknown"
                value={o.submissionUnknown}
                tone={o.submissionUnknown ? 'warning' : undefined}
                hint="needs review"
              />
              <Stat label="Webhook backlog" value={o.webhooks.backlog} />
              <Stat
                label="Webhook dead letters"
                value={o.webhooks.dead}
                tone={o.webhooks.dead ? 'danger' : undefined}
              />
            </div>
          </Section>
          <Section
            title="Usage this month"
            description="The quota is per project and counts accepted recipients."
          >
            <div className="rounded-md border bg-card p-4">
              <div className="mb-2 flex justify-between">
                <span className="font-mono tabular-nums">
                  {o.usage.acceptedRecipients.toLocaleString()} /{' '}
                  {o.usage.quota.recipients.toLocaleString()}
                </span>
                <span className="text-muted-foreground">
                  {o.usage.quota.remaining.toLocaleString()} remaining
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-label="Quota used"
                aria-valuemin={0}
                aria-valuemax={o.usage.quota.recipients}
                aria-valuenow={o.usage.acceptedRecipients}
              >
                <div
                  className="h-full bg-foreground/70"
                  style={{
                    width: `${Math.min(100, (o.usage.acceptedRecipients / Math.max(1, o.usage.quota.recipients)) * 100)}%`,
                  }}
                />
              </div>
            </div>
          </Section>
        </>
      )}
      <Section
        title="Send a test email"
        description="Uses the same acceptance pipeline as the API. With the local provider it lands in Mailpit."
      >
        {domains.data ? (
          <TestSend base={base} href={href} domains={domains.data} />
        ) : (
          <LoadingRows rows={1} cols={4} />
        )}
      </Section>
    </>
  );
}
