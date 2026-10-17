'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView } from '@/components/states';
import { EmailStatus } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate, relative } from '@/lib/format';
import { useApi, useEnvScope } from '@/lib/hooks';
import type { EmailListItem } from '@/lib/types';

const STATUSES = [
  '',
  'queued',
  'scheduled',
  'retry_wait',
  'submitted',
  'failed',
  'submission_unknown',
  'cancelled',
  'suppressed',
];

export default function EmailsPage() {
  const { base, projectId, envId } = useEnvScope();
  const router = useRouter();
  const [recipient, setRecipient] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const qs = new URLSearchParams({ limit: '25' });
  if (recipient) qs.set('recipient', recipient);
  if (status) qs.set('status', status);
  if (tag) qs.set('tag', tag);
  if (cursors.length) qs.set('cursor', cursors[cursors.length - 1]!);
  const list = useApi<{ data: EmailListItem[]; nextCursor: string | null }>(
    `${base}/emails?${qs}`,
    { refetchInterval: 10_000 },
  );
  const filtered = Boolean(recipient || status || tag);
  const clear = () => {
    setRecipient('');
    setStatus('');
    setTag('');
    setCursors([]);
  };
  return (
    <>
      <PageHeader
        title="Emails"
        description="Every email accepted in this environment, newest first."
      />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setRecipient(String(f.get('recipient') ?? '').trim());
          setTag(String(f.get('tag') ?? '').trim());
          setCursors([]);
        }}
      >
        <Input
          name="recipient"
          placeholder="Recipient address"
          defaultValue={recipient}
          className="w-64"
          aria-label="Filter by recipient"
        />
        <Input
          name="tag"
          placeholder="Tag (name or name:value)"
          defaultValue={tag}
          className="w-52"
          aria-label="Filter by tag"
        />
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => (setStatus(e.target.value), setCursors([]))}
          className="h-9 rounded-md border border-input bg-card px-2"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? s.replace('_', ' ') : 'Any status'}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline">
          Search
        </Button>
        {filtered && (
          <Button type="button" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        )}
      </form>
      <QueryView query={list} what="the emails" loading={<LoadingRows rows={8} cols={5} />}>
        {(page) =>
          page.data.length === 0 ? (
            filtered ? (
              <EmptyState
                title="No emails match these filters"
                action={
                  <Button variant="outline" onClick={clear}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState title="No emails in this environment yet">
                Send one with your API key or the test form on the overview. Accepted emails appear
                here immediately.
              </EmptyState>
            )
          ) : (
            <>
              <DataTable
                rows={page.data}
                rowKey={(e) => e.id}
                onRowClick={(e) => router.push(`/p/${projectId}/e/${envId}/emails/${e.id}`)}
                columns={[
                  { header: 'Status', cell: (e) => <EmailStatus status={e.displayStatus} /> },
                  {
                    header: 'Subject',
                    cell: (e) => (
                      <Link
                        href={`/p/${projectId}/e/${envId}/emails/${e.id}`}
                        className="block max-w-[340px] truncate font-medium hover:text-primary"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        {e.subject ?? (
                          <span className="italic text-muted-foreground">content purged</span>
                        )}
                      </Link>
                    ),
                  },
                  {
                    header: 'From',
                    cell: (e) => <span className="block max-w-[220px] truncate">{e.from}</span>,
                  },
                  {
                    header: 'Recipients',
                    cell: (e) => (
                      <span
                        className="font-mono text-[12.5px] tabular-nums"
                        title={`${e.summary.submitted} submitted · ${e.summary.delivered} delivered · ${e.summary.bounced} bounced · ${e.summary.rejected} rejected · ${e.summary.suppressed} suppressed`}
                      >
                        {e.summary.total}
                        {e.summary.total > 1 && (
                          <span className="text-muted-foreground">
                            {' '}
                            ({e.summary.delivered} delivered,{' '}
                            {e.summary.bounced + e.summary.rejected + e.summary.failed} not)
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    header: 'Accepted',
                    cell: (e) => (
                      <span title={formatDate(e.createdAt)} className="whitespace-nowrap">
                        {relative(e.createdAt)}
                      </span>
                    ),
                  },
                  {
                    header: 'ID',
                    cell: (e) => <Mono className="text-muted-foreground">{e.id.slice(0, 8)}</Mono>,
                  },
                ]}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursors.length === 0}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  Newer
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!page.nextCursor}
                  onClick={() => page.nextCursor && setCursors((c) => [...c, page.nextCursor!])}
                >
                  Older
                </Button>
              </div>
            </>
          )
        }
      </QueryView>
    </>
  );
}
