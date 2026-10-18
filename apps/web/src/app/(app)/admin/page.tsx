'use client';

import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { DataTable } from '@/components/data-table';
import { EmptyState, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction, useApi } from '@/lib/hooks';

interface AdminProject {
  id: string;
  name: string;
  organization: string;
  pausedAt: string | null;
  pausedReason: string | null;
}
interface AdminConnection {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  project: string;
  organization: string;
  pausedAt: string | null;
  pausedReason: string | null;
}
interface PlatformSuppression {
  id: string;
  address: string;
  reason: string;
  createdAt: string;
}

/** Pause with a reason the tenant will see; recorded in the audit log. */
function PauseButton({
  what,
  onPause,
}: {
  what: string;
  onPause: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <Confirm
      trigger={
        <Button size="sm" variant="outline">
          Pause
        </Button>
      }
      title={`Pause ${what}?`}
      description={
        <div className="grid gap-2">
          <p>
            New emails are rejected and queued emails wait until you resume. The tenant sees that
            sending is paused. This is recorded in the audit log.
          </p>
          <label htmlFor="pause-reason" className="font-medium text-foreground">
            Reason (shown to the tenant)
          </label>
          <Input id="pause-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      }
      confirmLabel="Pause sending"
      onConfirm={() =>
        onPause(reason.trim().length >= 3 ? reason.trim() : 'paused by the instance operator')
      }
    />
  );
}

const state = (pausedAt: string | null, reason: string | null) =>
  pausedAt ? (
    <Pill tone="danger" title={reason ?? ''}>
      Paused
    </Pill>
  ) : (
    <Pill tone="success">Active</Pill>
  );

export default function AdminPage() {
  const projects = useApi<AdminProject[]>('/admin/projects');
  const connections = useApi<AdminConnection[]>('/admin/connections');
  const blocks = useApi<PlatformSuppression[]>('/admin/suppressions');
  const [blockError, setBlockError] = useState<string | null>(null);

  const pauseProject = useAction(
    (v: { id: string; reason: string }) =>
      api(`/admin/projects/${v.id}/pause`, { method: 'POST', body: { reason: v.reason } }),
    {
      success: 'Project paused',
      error: 'Could not pause the project',
      invalidate: ['/admin/projects'],
    },
  );
  const resumeProject = useAction(
    (id: string) => api(`/admin/projects/${id}/resume`, { method: 'POST', body: {} }),
    {
      success: 'Project resumed',
      error: 'Could not resume the project',
      invalidate: ['/admin/projects'],
    },
  );
  const pauseConnection = useAction(
    (v: { id: string; reason: string }) =>
      api(`/admin/connections/${v.id}/pause`, { method: 'POST', body: { reason: v.reason } }),
    {
      success: 'Connection paused',
      error: 'Could not pause the connection',
      invalidate: ['/admin/connections'],
    },
  );
  const resumeConnection = useAction(
    (id: string) => api(`/admin/connections/${id}/resume`, { method: 'POST', body: {} }),
    {
      success: 'Connection resumed',
      error: 'Could not resume the connection',
      invalidate: ['/admin/connections'],
    },
  );
  const addBlock = useAction(
    (body: unknown) => api('/admin/suppressions', { method: 'POST', body }),
    {
      success: 'Address blocked instance-wide',
      error: 'Could not add the address',
      invalidate: ['/admin/suppressions'],
    },
  );
  const removeBlock = useAction(
    (id: string) => api(`/admin/suppressions/${id}`, { method: 'DELETE' }),
    {
      success: 'Block removed',
      error: 'Could not remove the block',
      invalidate: ['/admin/suppressions'],
    },
  );

  return (
    <>
      <PageHeader
        title="Instance operator"
        description="Controls for this OpenSend installation. Operators can pause sending and block addresses; they get no access to tenant email data here."
      />

      <Section title="Projects">
        <QueryView query={projects} what="the projects">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="No projects on this instance yet" />
            ) : (
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                columns={[
                  { header: 'Organization', cell: (r) => r.organization },
                  { header: 'Project', cell: (r) => r.name },
                  { header: 'State', cell: (r) => state(r.pausedAt, r.pausedReason) },
                  {
                    header: '',
                    className: 'text-right',
                    cell: (r) =>
                      r.pausedAt ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resumeProject.mutate(r.id)}
                        >
                          Resume
                        </Button>
                      ) : (
                        <PauseButton
                          what={r.name}
                          onPause={(reason) => pauseProject.mutateAsync({ id: r.id, reason })}
                        />
                      ),
                  },
                ]}
              />
            )
          }
        </QueryView>
      </Section>

      <Section
        title="Provider connections"
        description="Pausing a connection holds every email that uses it, across its environment."
      >
        <QueryView query={connections} what="the provider connections">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="No provider connections yet" />
            ) : (
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                columns={[
                  {
                    header: 'Connection',
                    cell: (r) => (
                      <>
                        <p className="font-medium">{r.name}</p>
                        <p className="text-muted-foreground">
                          {r.organization} · {r.project}
                        </p>
                      </>
                    ),
                  },
                  { header: 'Type', cell: (r) => <Pill>{r.type.toUpperCase()}</Pill> },
                  {
                    header: 'Tenant switch',
                    cell: (r) => (r.enabled ? 'enabled' : 'disabled by tenant'),
                  },
                  { header: 'State', cell: (r) => state(r.pausedAt, r.pausedReason) },
                  {
                    header: '',
                    className: 'text-right',
                    cell: (r) =>
                      r.pausedAt ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resumeConnection.mutate(r.id)}
                        >
                          Resume
                        </Button>
                      ) : (
                        <PauseButton
                          what={r.name}
                          onPause={(reason) => pauseConnection.mutateAsync({ id: r.id, reason })}
                        />
                      ),
                  },
                ]}
              />
            )
          }
        </QueryView>
      </Section>

      <Section
        title="Platform block list"
        description="Addresses no tenant can send to. Tenants only see the reason “policy”, never this note."
      >
        <form
          className="mb-3 flex flex-wrap items-end gap-2 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setBlockError(null);
            try {
              await addBlock.mutateAsync({ address: f.get('address'), reason: f.get('reason') });
              form.reset();
            } catch (err) {
              setBlockError(errorMessage(err, 'Could not add the address.'));
            }
          }}
        >
          <Field id="block-address" label="Email address">
            <Input id="block-address" name="address" type="email" required className="w-72" />
          </Field>
          <Field id="block-reason" label="Internal note">
            <Input id="block-reason" name="reason" required minLength={3} className="w-72" />
          </Field>
          <Button type="submit">Block address</Button>
          <div className="basis-full">
            <FormError message={blockError} />
          </div>
        </form>
        <QueryView query={blocks} what="the block list">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="No instance-wide blocks" />
            ) : (
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                columns={[
                  { header: 'Address', cell: (r) => <Mono>{r.address}</Mono> },
                  { header: 'Note', cell: (r) => r.reason },
                  { header: 'Added', cell: (r) => formatDate(r.createdAt) },
                  {
                    header: '',
                    className: 'text-right',
                    cell: (r) => (
                      <Button size="sm" variant="ghost" onClick={() => removeBlock.mutate(r.id)}>
                        Remove
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
