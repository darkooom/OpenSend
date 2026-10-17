'use client';

import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { DataTable } from '@/components/data-table';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';

interface Suppression {
  id: string;
  address: string;
  reason: 'hard_bounce' | 'complaint' | 'manual';
  note: string | null;
  sourceEmailId: string | null;
  createdAt: string;
}
const REASON = {
  hard_bounce: { label: 'Hard bounce', tone: 'danger' },
  complaint: { label: 'Complaint', tone: 'danger' },
  manual: { label: 'Manual', tone: 'neutral' },
} as const;

export default function SuppressionsPage() {
  const { base, projectId, envId } = useEnvScope();
  const [q, setQ] = useState('');
  const list = useApi<Suppression[]>(
    `${base}/suppressions${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  );
  const [error, setError] = useState<string | null>(null);
  const add = useAction((body: unknown) => api(`${base}/suppressions`, { method: 'POST', body }), {
    success: 'Address suppressed',
    error: 'Could not add the address',
    invalidate: [`${base}/suppressions`],
  });
  const remove = useAction(
    (id: string) => api(`${base}/suppressions/${id}`, { method: 'DELETE' }),
    { success: 'Suppression removed', error: 'Could not remove it' },
  );
  return (
    <>
      <PageHeader
        title="Suppressions"
        description="Addresses in this environment that never receive email. Hard bounces and complaints are added automatically when the provider reports them."
      />
      <Section title="Suppress an address">
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setError(null);
            try {
              await add.mutateAsync({
                address: f.get('address'),
                note: f.get('note') || undefined,
              });
              form.reset();
            } catch (err) {
              setError(errorMessage(err, 'Could not add the address.'));
            }
          }}
        >
          <Field id="sup-address" label="Email address">
            <Input id="sup-address" name="address" type="email" required className="w-72" />
          </Field>
          <Field id="sup-note" label="Note">
            <Input id="sup-note" name="note" className="w-64" />
          </Field>
          <Button type="submit">Suppress</Button>
          <div className="basis-full">
            <FormError message={error} />
          </div>
        </form>
      </Section>
      <div className="mb-3">
        <Input
          aria-label="Search suppressions"
          placeholder="Search address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-72"
        />
      </div>
      <QueryView
        query={list}
        what="the suppression list"
        loading={<LoadingRows rows={4} cols={4} />}
      >
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={q ? `No suppressed address matches “${q}”` : 'Nothing suppressed'}>
              {q ? undefined : 'Good news: no hard bounces or complaints so far.'}
            </EmptyState>
          ) : (
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              columns={[
                { header: 'Address', cell: (r) => <Mono>{r.address}</Mono> },
                {
                  header: 'Reason',
                  cell: (r) => <Pill tone={REASON[r.reason].tone}>{REASON[r.reason].label}</Pill>,
                },
                {
                  header: 'Source',
                  cell: (r) =>
                    r.sourceEmailId ? (
                      <a
                        className="font-mono text-primary underline"
                        href={`/p/${projectId}/e/${envId}/emails/${r.sourceEmailId}`}
                      >
                        {r.sourceEmailId.slice(0, 8)}
                      </a>
                    ) : (
                      (r.note ?? '—')
                    ),
                },
                { header: 'Added', cell: (r) => formatDate(r.createdAt) },
                {
                  header: '',
                  className: 'text-right',
                  cell: (r) => (
                    <Confirm
                      trigger={
                        <Button size="sm" variant="ghost">
                          Remove
                        </Button>
                      }
                      title={`Allow email to ${r.address} again?`}
                      description={
                        r.reason === 'manual'
                          ? 'The address can receive email from this environment again.'
                          : 'This address bounced hard or complained. Sending to it again can hurt your sender reputation.'
                      }
                      confirmLabel="Remove suppression"
                      onConfirm={async () => {
                        await remove.mutateAsync(r.id);
                        await list.refetch();
                      }}
                    />
                  ),
                },
              ]}
            />
          )
        }
      </QueryView>
    </>
  );
}
