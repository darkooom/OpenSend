'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { WEBHOOK_EVENT_TYPES } from '@opensend/contracts';
import { Field, FormError } from '@/components/auth-card';
import { OneTimeSecret } from '@/components/copy';
import { DataTable } from '@/components/data-table';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { relative } from '@/lib/format';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  rotating: boolean;
}
interface Dead {
  id: string;
  event_type: string;
  url: string;
  attempt_count: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
}

export default function WebhooksPage() {
  const { base, projectId, envId } = useEnvScope();
  const router = useRouter();
  const list = useApi<Endpoint[]>(`${base}/webhooks`);
  const dead = useApi<Dead[]>(`${base}/webhook-deliveries/dead`, { refetchInterval: 15_000 });
  const [types, setTypes] = useState<string[]>([
    'email.submitted',
    'email.failed',
    'email.delivered',
    'email.bounced',
    'email.complained',
  ]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    (body: unknown) => api<{ secret: string }>(`${base}/webhooks`, { method: 'POST', body }),
    {
      error: 'Could not create the endpoint',
      invalidate: [`${base}/webhooks`],
      onSuccess: (r) => setSecret(r.secret),
    },
  );
  const replay = useAction(
    (id: string) => api(`${base}/webhook-deliveries/${id}/replay`, { method: 'POST', body: {} }),
    {
      success: 'Replay queued (same event id, no email is sent)',
      error: 'Replay failed',
      invalidate: [`${base}/webhook-deliveries/dead`],
    },
  );
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Signed lifecycle events, delivered at least once and possibly out of order. Deduplicate on the event id."
      />
      <Section title="Add an endpoint">
        <form
          className="grid gap-4 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setError(null);
            setSecret(null);
            try {
              await create.mutateAsync({
                url: f.get('url'),
                description: f.get('description') || undefined,
                eventTypes: types,
              });
              form.reset();
            } catch (err) {
              setError(errorMessage(err, 'Could not create the endpoint.'));
            }
          }}
        >
          <div className="flex flex-wrap gap-4">
            <Field
              id="wh-url"
              label="URL"
              hint="HTTPS, publicly reachable. Private and metadata addresses are refused."
            >
              <Input
                id="wh-url"
                name="url"
                type="url"
                required
                placeholder="https://example.com/opensend/webhook"
                className="w-[28rem] font-mono"
              />
            </Field>
            <Field id="wh-desc" label="Description">
              <Input id="wh-desc" name="description" className="w-64" />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 font-medium">Events</legend>
            <div className="grid gap-1 md:grid-cols-3">
              {WEBHOOK_EVENT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={types.includes(t)}
                    onChange={(e) =>
                      setTypes((x) => (e.target.checked ? [...x, t] : x.filter((y) => y !== t)))
                    }
                  />
                  <Mono>{t}</Mono>
                </label>
              ))}
            </div>
          </fieldset>
          <FormError message={error} />
          {secret && <OneTimeSecret value={secret} what="signing secret" />}
          <div>
            <Button type="submit" disabled={types.length === 0 || create.isPending}>
              Add endpoint
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Endpoints">
        <QueryView
          query={list}
          what="the webhook endpoints"
          loading={<LoadingRows rows={2} cols={3} />}
        >
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="No webhook endpoints">
                Add one to get notified about submitted, failed, delivered and bounced emails.
              </EmptyState>
            ) : (
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                onRowClick={(r) => router.push(`/p/${projectId}/e/${envId}/webhooks/${r.id}`)}
                columns={[
                  {
                    header: 'URL',
                    cell: (r) => (
                      <>
                        <Mono>{r.url}</Mono>
                        {r.description && <p className="text-muted-foreground">{r.description}</p>}
                      </>
                    ),
                  },
                  { header: 'Events', cell: (r) => `${r.eventTypes.length} types` },
                  {
                    header: 'State',
                    cell: (r) => (
                      <span className="flex gap-1">
                        {r.enabled ? <Pill tone="success">enabled</Pill> : <Pill>disabled</Pill>}
                        {r.rotating && <Pill tone="info">rotating secret</Pill>}
                      </span>
                    ),
                  },
                ]}
              />
            )
          }
        </QueryView>
      </Section>
      <Section
        title="Dead letters"
        description="Deliveries that failed permanently. Fix the receiver, then replay."
      >
        <QueryView query={dead} what="the dead letters" loading={<LoadingRows rows={2} cols={4} />}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="No failed deliveries">
                Everything was delivered or is still being retried.
              </EmptyState>
            ) : (
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                columns={[
                  { header: 'Event', cell: (r) => <Mono>{r.event_type}</Mono> },
                  {
                    header: 'Endpoint',
                    cell: (r) => <Mono className="text-muted-foreground">{r.url}</Mono>,
                  },
                  { header: 'Attempts', cell: (r) => r.attempt_count },
                  {
                    header: 'Last error',
                    cell: (r) => (
                      <span className="text-destructive">
                        {r.last_status_code ? `HTTP ${r.last_status_code}` : r.last_error}
                      </span>
                    ),
                  },
                  { header: 'Created', cell: (r) => relative(r.created_at) },
                  {
                    header: '',
                    className: 'text-right',
                    cell: (r) => (
                      <Button size="sm" variant="outline" onClick={() => replay.mutate(r.id)}>
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
