'use client';

import { Confirm } from '@/components/confirm';
import { DataTable } from '@/components/data-table';
import { PageHeader, QueryView } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';

interface AdminProject {
  id: string;
  name: string;
  organization: string;
  pausedAt: string | null;
  pausedReason: string | null;
}

export default function AdminPage() {
  const projects = useApi<AdminProject[]>('/admin/projects');
  const [reason, setReason] = useState('');
  const pause = useAction(
    (v: { id: string; reason: string }) =>
      api(`/admin/projects/${v.id}/pause`, { method: 'POST', body: { reason: v.reason } }),
    {
      success: 'Project paused',
      error: 'Could not pause the project',
      invalidate: ['/admin/projects'],
    },
  );
  const resume = useAction(
    (id: string) => api(`/admin/projects/${id}/resume`, { method: 'POST', body: {} }),
    {
      success: 'Project resumed',
      error: 'Could not resume the project',
      invalidate: ['/admin/projects'],
    },
  );
  return (
    <>
      <PageHeader
        title="Instance operator"
        description="Pause sending for a project (abuse, incidents). Paused projects reject new emails with 423 and hold queued work. Operators do not get access to tenant email data here."
      />
      <QueryView query={projects} what="the projects">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: 'Organization', cell: (r) => r.organization },
              { header: 'Project', cell: (r) => r.name },
              {
                header: 'State',
                cell: (r) =>
                  r.pausedAt ? (
                    <Pill tone="danger" title={r.pausedReason ?? ''}>
                      Paused
                    </Pill>
                  ) : (
                    <Pill tone="success">Active</Pill>
                  ),
              },
              {
                header: '',
                className: 'text-right',
                cell: (r) =>
                  r.pausedAt ? (
                    <Button size="sm" variant="outline" onClick={() => resume.mutate(r.id)}>
                      Resume
                    </Button>
                  ) : (
                    <Confirm
                      trigger={
                        <Button size="sm" variant="outline">
                          Pause sending
                        </Button>
                      }
                      title={`Pause ${r.name}?`}
                      description={
                        <div className="grid gap-2">
                          <p>
                            New emails are rejected and queued emails wait until you resume. The
                            tenant sees that sending is paused. This is recorded in the audit log.
                          </p>
                          <label htmlFor="pause-reason" className="font-medium text-foreground">
                            Reason (shown to the tenant)
                          </label>
                          <Input
                            id="pause-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </div>
                      }
                      confirmLabel="Pause sending"
                      onConfirm={() =>
                        pause.mutateAsync({
                          id: r.id,
                          reason:
                            reason.trim().length >= 3
                              ? reason.trim()
                              : 'paused by the instance operator',
                        })
                      }
                    />
                  ),
              },
            ]}
          />
        )}
      </QueryView>
    </>
  );
}
