'use client';

import { ArrowLeft, Download } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Confirm } from '@/components/confirm';
import { DataTable } from '@/components/data-table';
import { HtmlPreview } from '@/components/html-preview';
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  Mono,
  PageHeader,
  QueryView,
  Section,
} from '@/components/states';
import { EmailStatus, Pill, RecipientStatus, emailStatusHint } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { bytes, formatDate } from '@/lib/format';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';
import type { EmailResource } from '@/lib/types';

interface Detail extends EmailResource {
  attemptsDetail: Array<{
    number: number;
    outcome: string;
    errorCategory: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    providerMessageId: string | null;
    providerResponse: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
  timeline: Array<{
    id: string;
    type: string;
    source: string;
    recipient: string | null;
    occurredAt: string;
    data: Record<string, unknown>;
  }>;
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    purgedAt: string | null;
  }>;
}
interface Content {
  subject: string | null;
  purged: boolean;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  replyTo: string[];
}

const CANCELLABLE = ['accepted', 'scheduled', 'queued', 'retry_wait'];
const ATTEMPT_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  accepted: 'success',
  transient_failure: 'warning',
  permanent_failure: 'danger',
  unknown: 'warning',
  started: 'info',
};

function ContentPanel({ base, emailId }: { base: string; emailId: string }) {
  const content = useApi<Content>(`${base}/emails/${emailId}/content`);
  if (content.error instanceof ApiError && content.error.status === 403) {
    return (
      <EmptyState title="Message content is hidden for your role">
        Viewers can see delivery metadata but not message content. Ask a developer or admin if you
        need it.
      </EmptyState>
    );
  }
  return (
    <QueryView
      query={content}
      what="the message content"
      loading={<LoadingRows rows={3} cols={1} />}
    >
      {(c) =>
        c.purged ? (
          <EmptyState title="Content no longer stored">
            This project&apos;s retention policy removed the message content after it was handed
            off. Metadata and events remain.
          </EmptyState>
        ) : (
          <Tabs defaultValue={c.html ? 'html' : 'text'}>
            <TabsList>
              {c.html && <TabsTrigger value="html">HTML preview</TabsTrigger>}
              {c.text && <TabsTrigger value="text">Plain text</TabsTrigger>}
              <TabsTrigger value="headers">Headers</TabsTrigger>
            </TabsList>
            {c.html && (
              <TabsContent value="html">
                <HtmlPreview html={c.html} />
              </TabsContent>
            )}
            {c.text && (
              <TabsContent value="text">
                <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border bg-card p-4 font-mono text-[12.5px]">
                  {c.text}
                </pre>
              </TabsContent>
            )}
            <TabsContent value="headers">
              <div className="rounded-md border bg-card p-4 font-mono text-[12.5px]">
                {c.replyTo.length > 0 && <p>Reply-To: {c.replyTo.join(', ')}</p>}
                {Object.entries(c.headers).map(([k, v]) => (
                  <p key={k}>
                    {k}: {v}
                  </p>
                ))}
                {c.replyTo.length === 0 && Object.keys(c.headers).length === 0 && (
                  <p className="text-muted-foreground">No custom headers.</p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        )
      }
    </QueryView>
  );
}

export default function EmailDetailPage() {
  const { base, projectId, envId } = useEnvScope();
  const { emailId } = useParams<{ emailId: string }>();
  const router = useRouter();
  const detail = useApi<Detail>(`${base}/emails/${emailId}`, { refetchInterval: 5_000 });
  const [resendError, setResendError] = useState<string | null>(null);
  const cancel = useAction(
    () => api(`${base}/emails/${emailId}/cancel`, { method: 'POST', body: {} }),
    {
      success: 'Email cancelled',
      error: 'The email could not be cancelled',
      invalidate: [`${base}/emails/${emailId}`],
    },
  );

  if (detail.isLoading) return <LoadingRows rows={6} cols={3} />;
  if (detail.error || !detail.data)
    return (
      <ErrorState error={detail.error} what="this email" onRetry={() => void detail.refetch()} />
    );
  const e = detail.data;
  const mayDuplicate = ['submitted', 'submission_unknown'].includes(e.status);
  const resendable =
    ['submitted', 'submission_unknown', 'failed', 'cancelled', 'suppressed'].includes(e.status) &&
    !e.contentPurged;

  return (
    <>
      <Link
        href={`/p/${projectId}/e/${envId}/emails`}
        className="mb-3 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Emails
      </Link>
      <PageHeader
        title={e.subject ?? 'Subject not stored'}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <EmailStatus status={e.displayStatus} />
            <span>{emailStatusHint(e.displayStatus)}</span>
          </span>
        }
        actions={
          <>
            {CANCELLABLE.includes(e.status) && (
              <Confirm
                trigger={<Button variant="outline">Cancel email</Button>}
                title="Cancel this email?"
                description="It has not been handed to the provider yet, so it will not be sent."
                confirmLabel="Cancel email"
                onConfirm={() => cancel.mutateAsync(undefined)}
              />
            )}
            {resendable && (
              <Confirm
                trigger={<Button variant="outline">Resend…</Button>}
                destructive={mayDuplicate}
                title="Send this email again?"
                description={
                  <div className="grid gap-2">
                    <p>
                      This creates a new, linked email with the stored content and the same
                      recipients.
                    </p>
                    {mayDuplicate && (
                      <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning">
                        The original{' '}
                        {e.status === 'submitted'
                          ? 'was accepted by the provider'
                          : 'may have been accepted by the provider'}
                        . Recipients may get it twice.
                      </p>
                    )}
                    {resendError && <p className="text-destructive">{resendError}</p>}
                  </div>
                }
                confirmLabel={mayDuplicate ? 'Send possible duplicate' : 'Resend'}
                onConfirm={async () => {
                  try {
                    const r = await api<{ id: string }>(`${base}/emails/${emailId}/resend`, {
                      method: 'POST',
                      body: { confirmDuplicate: mayDuplicate },
                    });
                    router.push(`/p/${projectId}/e/${envId}/emails/${r.id}`);
                  } catch (err) {
                    setResendError(err instanceof Error ? err.message : 'Resend failed');
                    throw err;
                  }
                }}
              />
            )}
          </>
        }
      />
      <dl className="mb-8 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border bg-card p-4 md:grid-cols-4">
        {[
          ['From', e.from],
          ['Email ID', <Mono key="id">{e.id}</Mono>],
          ['Accepted', formatDate(e.createdAt)],
          ['Submitted', formatDate(e.submittedAt)],
          ['Scheduled for', formatDate(e.scheduledAt)],
          ['Attempts', String(e.attempts)],
          [
            'Tags',
            Object.keys(e.tags).length
              ? Object.entries(e.tags)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(', ')
              : '—',
          ],
          [
            'Resend of',
            e.resendOf ? (
              <Link
                key="r"
                className="font-mono text-primary underline"
                href={`/p/${projectId}/e/${envId}/emails/${e.resendOf}`}
              >
                {e.resendOf.slice(0, 8)}
              </Link>
            ) : (
              '—'
            ),
          ],
        ].map(([k, v]) => (
          <div key={String(k)} className="min-w-0">
            <dt className="text-[12px] text-muted-foreground">{k}</dt>
            <dd className="truncate">{v}</dd>
          </div>
        ))}
        {e.lastError && (
          <div className="col-span-2 md:col-span-4">
            <dt className="text-[12px] text-muted-foreground">Last error</dt>
            <dd className="text-destructive">
              <Mono>
                {e.lastError.category}/{e.lastError.code}
              </Mono>{' '}
              {e.lastError.message}
            </dd>
          </div>
        )}
      </dl>

      <Section
        title={`Recipients (${e.summary.total})`}
        description="Submission and delivery are tracked per recipient. Delivery facts only come from provider events."
      >
        <DataTable
          rows={e.recipients}
          rowKey={(r) => `${r.kind}:${r.address}`}
          columns={[
            { header: 'Address', cell: (r) => <Mono>{r.address}</Mono> },
            { header: 'Type', cell: (r) => r.kind.toUpperCase() },
            {
              header: 'Submission',
              cell: (r) => (
                <>
                  <RecipientStatus status={r.status} />{' '}
                  {r.statusDetail && (
                    <span className="text-muted-foreground">{r.statusDetail}</span>
                  )}
                </>
              ),
            },
            {
              header: 'Delivery events',
              cell: (r) => (
                <span className="flex flex-wrap gap-1">
                  {r.deliveredAt && (
                    <Pill tone="success" title={formatDate(r.deliveredAt)}>
                      delivered
                    </Pill>
                  )}
                  {r.deferredAt && (
                    <Pill tone="warning" title={formatDate(r.deferredAt)}>
                      delayed
                    </Pill>
                  )}
                  {r.bouncedAt && (
                    <Pill tone="danger" title={formatDate(r.bouncedAt)}>
                      bounced{r.bounceType ? ` (${r.bounceType})` : ''}
                    </Pill>
                  )}
                  {r.complainedAt && (
                    <Pill tone="danger" title={formatDate(r.complainedAt)}>
                      complaint
                    </Pill>
                  )}
                  {!r.deliveredAt && !r.bouncedAt && !r.complainedAt && !r.deferredAt && (
                    <span className="text-muted-foreground">none reported</span>
                  )}
                </span>
              ),
            },
          ]}
        />
      </Section>

      <Section title="Content">
        <ContentPanel base={base} emailId={emailId} />
        {e.attachments.length > 0 && (
          <ul className="mt-3 grid gap-1">
            {e.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                {a.purgedAt ? (
                  <span className="text-muted-foreground">
                    {a.filename} (removed by retention policy)
                  </span>
                ) : (
                  <a
                    className="inline-flex items-center gap-1 text-primary underline"
                    href={`/api${base}/emails/${emailId}/attachments/${a.id}`}
                    download
                  >
                    <Download className="size-3.5" /> {a.filename}
                  </a>
                )}
                <span className="text-muted-foreground">
                  {a.contentType} · {bytes(a.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Submission attempts">
        {e.attemptsDetail.length === 0 ? (
          <EmptyState title="No attempt yet">
            {e.status === 'scheduled'
              ? 'The email waits for its scheduled time.'
              : 'A worker will pick it up shortly.'}
          </EmptyState>
        ) : (
          <DataTable
            rows={e.attemptsDetail}
            rowKey={(a) => String(a.number)}
            columns={[
              { header: '#', cell: (a) => a.number },
              {
                header: 'Outcome',
                cell: (a) => (
                  <Pill tone={ATTEMPT_TONE[a.outcome] ?? 'neutral'}>
                    {a.outcome.replace('_', ' ')}
                  </Pill>
                ),
              },
              { header: 'Started', cell: (a) => formatDate(a.startedAt) },
              {
                header: 'Error',
                cell: (a) =>
                  a.errorCode ? (
                    <>
                      <Mono>
                        {a.errorCategory}/{a.errorCode}
                      </Mono>{' '}
                      <span className="text-muted-foreground">{a.errorMessage}</span>
                    </>
                  ) : (
                    '—'
                  ),
              },
              {
                header: 'Provider',
                cell: (a) => (
                  <Mono className="text-muted-foreground">
                    {a.providerMessageId ?? a.providerResponse ?? '—'}
                  </Mono>
                ),
              },
            ]}
          />
        )}
      </Section>

      <Section
        title="Timeline"
        description="Append-only history. Later events never erase earlier ones."
      >
        <ol className="rounded-md border bg-card">
          {e.timeline.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-baseline gap-x-3 border-b px-4 py-2 last:border-0"
            >
              <span className="w-44 shrink-0 whitespace-nowrap text-muted-foreground">
                {formatDate(t.occurredAt)}
              </span>
              <Mono className="font-medium">{t.type}</Mono>
              {t.recipient && <Mono className="text-muted-foreground">{t.recipient}</Mono>}
              <Pill>{t.source}</Pill>
              {Object.keys(t.data).length > 0 && (
                <Mono className="basis-full pl-[11.75rem] text-muted-foreground">
                  {JSON.stringify(t.data)}
                </Mono>
              )}
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
