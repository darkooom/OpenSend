'use client';

import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { OneTimeSecret } from '@/components/copy';
import { DataTable } from '@/components/data-table';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { EnvBadge, Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatDate, relative } from '@/lib/format';
import { useAction, useApi, useEnvScope, useProject } from '@/lib/hooks';

interface Key {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  active: boolean;
}
const SCOPES = [
  ['emails:send', 'Send and cancel emails'],
  ['emails:read', 'Read email status'],
  ['domains:read', 'List domains'],
  ['domains:manage', 'Add and verify domains'],
  ['usage:read', 'Read usage and limits'],
] as const;

export default function ApiKeysPage() {
  const { base, projectId, envId } = useEnvScope();
  const project = useProject(projectId);
  const env = project.data?.environments.find((e) => e.id === envId);
  const keys = useApi<Key[]>(`${base}/api-keys`);
  const [created, setCreated] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>(['emails:send']);
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    (body: unknown) => api<{ key: string }>(`${base}/api-keys`, { method: 'POST', body }),
    {
      error: 'Could not create the key',
      invalidate: [`${base}/api-keys`],
      onSuccess: (r) => setCreated(r.key),
    },
  );
  const revoke = useAction((id: string) => api(`${base}/api-keys/${id}`, { method: 'DELETE' }), {
    success: 'Key revoked. Requests with it now fail with 401.',
    error: 'Could not revoke the key',
    invalidate: [`${base}/api-keys`],
  });
  return (
    <>
      <PageHeader
        title="API keys"
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            Keys belong to this project and environment{' '}
            {env && <EnvBadge kind={env.kind} name={env.name} />}. Use them server-side only.
          </span>
        }
      />
      <Section title="Create a key">
        <form
          className="grid gap-4 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setError(null);
            setCreated(null);
            const days = Number(f.get('expires'));
            try {
              await create.mutateAsync({
                name: f.get('name'),
                scopes,
                ...(days > 0
                  ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }
                  : {}),
              });
              form.reset();
            } catch (err) {
              setError(errorMessage(err, 'Could not create the key.'));
            }
          }}
        >
          <div className="flex flex-wrap gap-4">
            <Field id="key-name" label="Name" hint="Where it is used, e.g. “backend production”.">
              <Input id="key-name" name="name" required className="w-72" />
            </Field>
            <Field id="key-expires" label="Expires">
              <select
                id="key-expires"
                name="expires"
                defaultValue="0"
                className="h-9 rounded-md border border-input bg-card px-2"
              >
                <option value="0">Never</option>
                <option value="30">in 30 days</option>
                <option value="90">in 90 days</option>
                <option value="365">in 1 year</option>
              </select>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 font-medium">Permissions</legend>
            <div className="grid gap-1 md:grid-cols-2">
              {SCOPES.map(([s, label]) => (
                <label key={s} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))
                    }
                  />
                  <Mono>{s}</Mono> <span className="text-muted-foreground">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <FormError message={error} />
          {created && <OneTimeSecret value={created} what="API key" />}
          <div>
            <Button type="submit" disabled={create.isPending || scopes.length === 0}>
              Create key
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Keys">
        <QueryView query={keys} what="the API keys" loading={<LoadingRows rows={3} cols={5} />}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="No API keys in this environment">
                Create one to send email from your application.
              </EmptyState>
            ) : (
              <DataTable
                rows={rows}
                rowKey={(k) => k.id}
                columns={[
                  {
                    header: 'Name',
                    cell: (k) => (
                      <>
                        <p className="font-medium">{k.name}</p>
                        <Mono className="text-muted-foreground">{k.prefix}</Mono>
                      </>
                    ),
                  },
                  {
                    header: 'Scopes',
                    cell: (k) => (
                      <span className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Pill key={s}>{s}</Pill>
                        ))}
                      </span>
                    ),
                  },
                  {
                    header: 'Last used',
                    cell: (k) => (k.lastUsedAt ? relative(k.lastUsedAt) : 'never'),
                  },
                  {
                    header: 'Expires',
                    cell: (k) => (k.expiresAt ? formatDate(k.expiresAt) : 'never'),
                  },
                  {
                    header: 'State',
                    cell: (k) =>
                      k.revokedAt ? (
                        <Pill tone="neutral">revoked</Pill>
                      ) : k.active ? (
                        <Pill tone="success">active</Pill>
                      ) : (
                        <Pill tone="warning">expired</Pill>
                      ),
                  },
                  {
                    header: '',
                    className: 'text-right',
                    cell: (k) =>
                      k.active ? (
                        <Confirm
                          trigger={
                            <Button size="sm" variant="ghost">
                              Revoke
                            </Button>
                          }
                          title={`Revoke “${k.name}”?`}
                          description="Applications using this key stop working immediately. This cannot be undone."
                          confirmLabel="Revoke key"
                          onConfirm={() => revoke.mutateAsync(k.id)}
                        />
                      ) : null,
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
