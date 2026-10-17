'use client';

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { CopyButton } from '@/components/copy';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { relative } from '@/lib/format';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';
import type { DnsRecord, DomainResource } from '@/lib/types';

const RECORD_TONE = {
  found: 'success',
  missing: 'danger',
  mismatch: 'warning',
  unknown: 'neutral',
} as const;
const PROVIDER_TEXT: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }
> = {
  verified: { label: 'Verified by provider', tone: 'success' },
  pending: { label: 'Provider verification pending', tone: 'warning' },
  failed: { label: 'Provider verification failed', tone: 'danger' },
  not_started: { label: 'Provider not checked yet', tone: 'neutral' },
  not_required: { label: 'No provider verification needed', tone: 'neutral' },
  unsupported: { label: 'Provider has no domain verification', tone: 'info' },
};

function RecordRow({ r }: { r: DnsRecord }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="px-3 py-2">
        <Pill>{r.type}</Pill>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <Mono className="break-all">{r.name}</Mono>
          <CopyButton value={r.name} label="Name" />
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <Mono className="break-all">{r.value}</Mono>
          <CopyButton value={r.value} label="Value" />
        </div>
        {r.found.length > 0 && r.status !== 'found' && (
          <p className="mt-1 text-muted-foreground">
            Found: <Mono>{r.found.join(', ')}</Mono>
          </p>
        )}
        {r.note && <p className="mt-1 text-muted-foreground">{r.note}</p>}
      </td>
      <td className="px-3 py-2">
        <Pill tone={RECORD_TONE[r.status]}>
          {r.status === 'unknown' ? 'not checked' : r.status}
        </Pill>
      </td>
    </tr>
  );
}

function RecordsTable({ records }: { records: DnsRecord[] }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full text-left">
        <thead className="border-b text-[12px] text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Expected value</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <RecordRow key={`${r.type}:${r.name}`} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DomainCard({ d, base }: { d: DomainResource; base: string }) {
  const verify = useAction(
    () => api<DomainResource>(`${base}/domains/${d.id}/verify`, { method: 'POST', body: {} }),
    {
      success: (r) =>
        r.canSend ? `${d.name} can send` : `${d.name} checked: see the records below`,
      error: 'The check could not be run',
      invalidate: [`${base}/domains`],
    },
  );
  const remove = useAction(() => api(`${base}/domains/${d.id}`, { method: 'DELETE' }), {
    success: 'Domain removed',
    error: 'Could not remove the domain',
    invalidate: [`${base}/domains`],
  });
  const provider = PROVIDER_TEXT[d.provider.status] ?? {
    label: d.provider.status,
    tone: 'neutral' as const,
  };
  return (
    <article className="rounded-md border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h3 className="font-mono text-[15px] font-medium">{d.name}</h3>
        {d.canSend ? (
          <Pill tone="success">Can send</Pill>
        ) : (
          <Pill tone="warning">Cannot send yet</Pill>
        )}
        {d.localOnly && (
          <Pill
            tone="info"
            title="Reserved test domain: only for the local provider outside production"
          >
            Local only
          </Pill>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => verify.mutate(undefined)}
            disabled={verify.isPending}
          >
            <RefreshCw className={`size-3.5 ${verify.isPending ? 'animate-spin' : ''}`} />{' '}
            {verify.isPending ? 'Checking…' : 'Check DNS & provider'}
          </Button>
          <Confirm
            trigger={
              <Button size="sm" variant="ghost">
                Remove
              </Button>
            }
            title={`Remove ${d.name}?`}
            description="Emails from this domain will be rejected in this environment. Provider-side identities are not deleted."
            confirmLabel="Remove domain"
            typeToConfirm={d.name}
            onConfirm={() => remove.mutateAsync(undefined)}
          />
        </div>
      </header>
      <div className="grid gap-5 p-4">
        {!d.localOnly && (
          <div>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h4 className="font-medium">1. Ownership</h4>
              <Pill tone={d.ownership.status === 'verified' ? 'success' : 'warning'}>
                {d.ownership.status}
              </Pill>
              <span className="text-muted-foreground">
                Proves this project controls the domain. Each project has its own token.
              </span>
            </div>
            <RecordsTable records={[d.ownership.record]} />
            {d.ownership.lastError && d.ownership.status !== 'verified' && (
              <p className="mt-1 text-warning">{d.ownership.lastError}</p>
            )}
            {d.ownership.checkedAt && (
              <p className="mt-1 text-muted-foreground">
                Checked {relative(d.ownership.checkedAt)}
              </p>
            )}
          </div>
        )}
        {d.localOnly && <p className="text-muted-foreground">{d.ownership.record.note}</p>}
        {!d.localOnly && (
          <div>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h4 className="font-medium">2. Provider identity</h4>
              <Pill tone={provider.tone}>{provider.label}</Pill>
              {d.provider.type && (
                <span className="text-muted-foreground">via {d.provider.type.toUpperCase()}</span>
              )}
            </div>
            {d.provider.records.length > 0 ? (
              <RecordsTable records={d.provider.records} />
            ) : (
              <p className="text-muted-foreground">
                {d.provider.status === 'unsupported'
                  ? 'Your SMTP relay manages DKIM and sender authorization itself. Follow its documentation; OpenSend does not invent records for it.'
                  : d.provider.status === 'not_started'
                    ? 'Runs after ownership is verified, so no foreign domain is ever registered with your provider.'
                    : d.provider.status === 'not_required'
                      ? 'The local development provider does not need DNS records.'
                      : 'The provider reported no additional records.'}
              </p>
            )}
            {d.provider.lastError && (
              <p className="mt-1 text-destructive">{d.provider.lastError}</p>
            )}
          </div>
        )}
        {d.diagnostics && (
          <div>
            <h4 className="mb-2 font-medium">3. DNS diagnostics (advisory)</h4>
            <ul className="grid gap-1.5">
              {(['spf', 'dmarc'] as const).map((k) => (
                <li key={k} className="flex flex-wrap items-baseline gap-2">
                  <Pill
                    tone={
                      d.diagnostics![k].status === 'ok'
                        ? 'success'
                        : d.diagnostics![k].status === 'error'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {k.toUpperCase()}
                  </Pill>
                  <span>{d.diagnostics![k].message}</span>
                  {d.diagnostics![k].records.map((r) => (
                    <Mono key={r} className="basis-full text-muted-foreground">
                      {r}
                    </Mono>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

export default function DomainsPage() {
  const { base } = useEnvScope();
  const domains = useApi<DomainResource[]>(`${base}/domains`);
  const [error, setError] = useState<string | null>(null);
  const add = useAction(
    (name: string) => api(`${base}/domains`, { method: 'POST', body: { name } }),
    {
      success: 'Domain added. Publish the records, then run the check.',
      error: 'Could not add the domain',
      invalidate: [`${base}/domains`],
    },
  );
  return (
    <>
      <PageHeader
        title="Sender domains"
        description="Production sends only from domains with verified ownership (and provider verification where the provider supports it)."
      />
      <Section title="Add a domain">
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            setError(null);
            try {
              await add.mutateAsync(String(new FormData(form).get('name')).trim());
              form.reset();
            } catch (err) {
              setError(errorMessage(err, 'Could not add the domain.'));
            }
          }}
        >
          <Field
            id="domain-name"
            label="Domain"
            hint="Exactly the domain in your From address, e.g. mail.example.com. Reserved test domains (*.test) work with the local provider only."
          >
            <Input
              id="domain-name"
              name="name"
              required
              placeholder="mail.example.com"
              className="w-80 font-mono"
            />
          </Field>
          <Button type="submit" disabled={add.isPending}>
            Add domain
          </Button>
          <div className="basis-full">
            <FormError message={error} />
          </div>
        </form>
      </Section>
      <QueryView query={domains} what="the domains" loading={<LoadingRows rows={2} cols={3} />}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No sender domain yet">
              Add the domain you send from. You will get a TXT record that proves this project
              controls it.
            </EmptyState>
          ) : (
            <div className="grid gap-4">
              {rows.map((d) => (
                <DomainCard key={d.id} d={d} base={base} />
              ))}
            </div>
          )
        }
      </QueryView>
    </>
  );
}
