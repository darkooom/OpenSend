'use client';

import { useParams } from 'next/navigation';
import { DataTable } from '@/components/data-table';
import { EmptyState, Mono, PageHeader, QueryView } from '@/components/states';
import { Pill } from '@/components/status';
import { useApi, useOrg } from '@/lib/hooks';
import { formatDate } from '@/lib/format';

interface AuditEntry {
  id: string;
  projectId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const org = useOrg(orgId);
  const audit = useApi<AuditEntry[]>(`/orgs/${orgId}/audit`);
  const name = (id: string | null) =>
    id ? (org.data?.projects.find((p) => p.id === id)?.name ?? 'Project') : 'Organization';
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Security-relevant administrative actions. Contains no secrets and no message content. Showing the latest 100 entries."
      />
      <QueryView query={audit} what="the audit log">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="Nothing recorded yet" />
          ) : (
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              columns={[
                {
                  header: 'Time',
                  cell: (r) => <span className="whitespace-nowrap">{formatDate(r.createdAt)}</span>,
                },
                { header: 'Action', cell: (r) => <Mono>{r.action}</Mono> },
                { header: 'Scope', cell: (r) => name(r.projectId) },
                {
                  header: 'Actor',
                  cell: (r) => (
                    <>
                      <Pill>{r.actorType}</Pill>{' '}
                      <Mono className="text-muted-foreground">{r.actorId?.slice(0, 10)}</Mono>
                    </>
                  ),
                },
                {
                  header: 'Target',
                  cell: (r) =>
                    r.targetType ? (
                      <Mono className="text-muted-foreground">
                        {r.targetType}:{r.targetId?.slice(0, 8)}
                      </Mono>
                    ) : (
                      '—'
                    ),
                },
                {
                  header: 'Details',
                  cell: (r) => (
                    <Mono className="text-muted-foreground">
                      {Object.keys(r.metadata).length
                        ? JSON.stringify(r.metadata).slice(0, 80)
                        : ''}
                    </Mono>
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
