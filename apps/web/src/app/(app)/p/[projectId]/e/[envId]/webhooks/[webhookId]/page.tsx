'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Confirm } from '@/components/confirm';
import { OneTimeSecret } from '@/components/copy';
import { DataTable } from '@/components/data-table';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatDate, relative } from '@/lib/format';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  rotating: boolean;
}
interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  kind: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
  succeeded: 'success',
  retry_wait: 'warning',
  dead: 'danger',
  pending: 'info',
};

export default function WebhookDetail() {
  const { base, projectId, envId } = useEnvScope();
  const { webhookId } = useParams<{ webhookId: string }>();
  const endpoints = useApi<Endpoint[]>(`${base}/webhooks`);
  const [status, setStatus] = useState('');
  const deliveries = useApi<Delivery[]>(
    `${base}/webhooks/${webhookId}/deliveries${status ? `?status=${status}` : ''}`,
    { refetchInterval: 5_000 },
  );
  const [secret, setSecret] = useState<string | null>(null);
  const invalidate = [`${base}/webhooks`];
  const test = useAction(
    () => api(`${base}/webhooks/${webhookId}/test`, { method: 'POST', body: {} }),
    { success: 'Test event queued', error: 'Could not send a test event' },
  );
  const rotate = useAction(
    () =>
      api<{ secret: string }>(`${base}/webhooks/${webhookId}/rotate-secret`, {
        method: 'POST',
        body: {},
      }),
    { error: 'Rotation failed', invalidate, onSuccess: (r) => setSecret(r.secret) },
  );
  const toggle = useAction(
    (enabled: boolean) =>
      api(`${base}/webhooks/${webhookId}`, { method: 'PATCH', body: { enabled } }),
    { success: 'Saved', error: 'Could not update the endpoint', invalidate },
  );
  const remove = useAction(() => api(`${base}/webhooks/${webhookId}`, { method: 'DELETE' }), {
    success: 'Endpoint deleted',
    error: 'Could not delete it',
    onSuccess: () => (location.href = `/p/${projectId}/e/${envId}/webhooks`),
  });
  const replay = useAction(
    (id: string) => api(`${base}/webhook-deliveries/${id}/replay`, { method: 'POST', body: {} }),
    { success: 'Replay queued', error: 'Replay failed' },
  );
  const ep = endpoints.data?.find((e) => e.id === webhookId);
  return (
    <>
      <Link
        href={`/p/${projectId}/e/${envId}/webhooks`}
        className="mb-3 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Webhooks
      </Link>
      {!ep ? (
        endpoints.isLoading ? (
          <LoadingRows rows={2} cols={2} />
        ) : (
          <EmptyState title="Endpoint not found">It may have been deleted.</EmptyState>
        )
      ) : (
        <>
          <PageHeader
            title="Webhook endpoint"
            description={<Mono>{ep.url}</Mono>}
            actions={
              <>
                <Button variant="outline" onClick={() => test.mutate(undefined)}>
                  Send test event
                </Button>
                <Confirm
                  trigger={<Button variant="outline">Rotate secret</Button>}
                  destructive={false}
                  title="Rotate the signing secret?"
                  description="The new secret signs immediately. The old one keeps signing as a second signature for 24 hours so you can deploy the change."
                  confirmLabel="Rotate"
                  onConfirm={() => rotate.mutateAsync(undefined)}
                />
                <Button variant="ghost" onClick={() => toggle.mutate(!ep.enabled)}>
                  {ep.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Confirm
                  trigger={<Button variant="ghost">Delete</Button>}
                  title="Delete this endpoint?"
                  description="Pending deliveries are dropped."
                  confirmLabel="Delete endpoint"
                  onConfirm={() => remove.mutateAsync(undefined)}
                />
              </>
            }
          />
          {secret && (
            <div className="mb-6">
              <OneTimeSecret value={secret} what="new signing secret" />
            </div>
          )}
          <p className="mb-6 flex flex-wrap gap-1">
            {ep.eventTypes.map((t) => (
              <Pill key={t}>{t}</Pill>
            ))}
          </p>
        </>
      )}
      <Section
        title="Deliveries"
        description="Latest 100. A replay re-sends the same event (same id); it never sends an email."
        actions={
          <select
            aria-label="Filter deliveries"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-input bg-card px-2"
          >
            <option value="">All</option>
            <option value="succeeded">Succeeded</option>
            <option value="retry_wait">Retrying</option>
            <option value="dead">Dead</option>
          </select>
        }
      >
        <QueryView
          query={deliveries}
          what="the deliveries"
          loading={<LoadingRows rows={4} cols={5} />}
        >
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title={status ? 'No deliveries with this status' : 'No deliveries yet'}>
                {status ? undefined : 'Send a test event or an email to see deliveries here.'}
              </EmptyState>
            ) : (
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                columns={[
                  {
                    header: 'Event',
                    cell: (r) => (
                      <>
                        <Mono>{r.eventType}</Mono>{' '}
                        {r.kind !== 'event' && <Pill tone="info">{r.kind}</Pill>}
                      </>
                    ),
                  },
                  {
                    header: 'Status',
                    cell: (r) => (
                      <Pill tone={TONE[r.status] ?? 'info'}>{r.status.replace('_', ' ')}</Pill>
                    ),
                  },
                  { header: 'Attempts', cell: (r) => r.attempts },
                  {
                    header: 'Last result',
                    cell: (r) =>
                      r.lastStatusCode ? `HTTP ${r.lastStatusCode}` : (r.lastError ?? '—'),
                  },
                  {
                    header: 'Next attempt',
                    cell: (r) => (r.nextAttemptAt ? formatDate(r.nextAttemptAt) : '—'),
                  },
                  { header: 'Created', cell: (r) => relative(r.createdAt) },
                  {
                    header: '',
                    className: 'text-right',
                    cell: (r) => (
                      <Button size="sm" variant="ghost" onClick={() => replay.mutate(r.id)}>
                        Replay
                      </Button>
                    ),
                  },
                ]}
              />
            )
          }
        </QueryView>
      </Section>
    </>
  );
}
