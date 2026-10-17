'use client';

import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { CopyButton } from '@/components/copy';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';

interface Connection {
  id: string;
  name: string;
  type: 'local' | 'smtp' | 'ses';
  config: Record<string, unknown>;
  hasSecrets: boolean;
  isDefault: boolean;
  enabled: boolean;
  paused: { at: string; reason: string | null } | null;
  capabilities: {
    send: boolean;
    domainVerification: boolean;
    deliveryEvents: boolean;
    statusLookup: boolean;
  };
  eventsEndpoint: string | null;
}

const CAPS: Array<[keyof Connection['capabilities'], string]> = [
  ['send', 'Sending'],
  ['domainVerification', 'Domain verification'],
  ['deliveryEvents', 'Delivery / bounce / complaint events'],
  ['statusLookup', 'Status lookup after unclear hand-off'],
];
const TYPE_INFO = {
  local: 'Delivers to the Mailpit inbox configured by the operator. Development and staging only.',
  smtp: 'Any SMTP relay with TLS. Plain SMTP gives no delivery events.',
  ses: 'Amazon SES via the official SDK. Delivery events arrive through SNS.',
};

function AddConnection({ base, localAvailable }: { base: string; localAvailable: boolean }) {
  const [type, setType] = useState<'local' | 'smtp' | 'ses'>(localAvailable ? 'local' : 'smtp');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((body: unknown) => api(`${base}/providers`, { method: 'POST', body }), {
    success: 'Connection saved',
    error: 'Could not save the connection',
    invalidate: [`${base}/providers`],
  });
  const types = (['local', 'smtp', 'ses'] as const).filter((t) => t !== 'local' || localAvailable);
  return (
    <form
      className="grid gap-4 rounded-md border bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const body: Record<string, unknown> = { name: f.get('name'), type, isDefault: true };
        if (type === 'smtp') {
          body.config = {
            host: f.get('host'),
            port: Number(f.get('port')),
            security: f.get('security'),
            ...(f.get('username') ? { username: f.get('username') } : {}),
          };
          body.secrets = f.get('password') ? { password: f.get('password') } : {};
        }
        if (type === 'ses') {
          const topics = String(f.get('topics') ?? '')
            .split(/[\s,]+/)
            .filter(Boolean);
          body.config = {
            region: f.get('region'),
            ...(f.get('configurationSet')
              ? { configurationSetName: f.get('configurationSet') }
              : {}),
            snsTopicArns: topics,
          };
          body.secrets = {
            accessKeyId: f.get('accessKeyId'),
            secretAccessKey: f.get('secretAccessKey'),
          };
        }
        setError(null);
        try {
          await create.mutateAsync(body);
          form.reset();
        } catch (err) {
          setError(errorMessage(err, 'Could not save the connection.'));
        }
      }}
    >
      <fieldset>
        <legend className="mb-1 font-medium">Provider</legend>
        <div className="inline-flex rounded-md border p-0.5" role="radiogroup">
          {types.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={`rounded-sm px-3 py-1 ${type === t ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground'}`}
            >
              {t === 'local' ? 'Local (Mailpit)' : t === 'smtp' ? 'SMTP relay' : 'Amazon SES'}
            </button>
          ))}
        </div>
        <p className="mt-1 text-muted-foreground">{TYPE_INFO[type]}</p>
      </fieldset>
      <Field id="conn-name" label="Name">
        <Input
          id="conn-name"
          name="name"
          required
          defaultValue={type === 'local' ? 'Mailpit' : ''}
          key={type}
          className="w-72"
        />
      </Field>
      {type === 'smtp' && (
        <div className="grid gap-4 md:grid-cols-4">
          <Field id="host" label="Host">
            <Input
              id="host"
              name="host"
              required
              placeholder="smtp.relay.example"
              className="font-mono"
            />
          </Field>
          <Field id="port" label="Port">
            <Input id="port" name="port" type="number" required defaultValue={587} />
          </Field>
          <Field id="security" label="TLS">
            <select
              id="security"
              name="security"
              className="h-9 rounded-md border border-input bg-card px-2"
            >
              <option value="starttls">STARTTLS (587)</option>
              <option value="tls">Implicit TLS (465)</option>
            </select>
          </Field>
          <span />
          <Field id="username" label="Username">
            <Input id="username" name="username" autoComplete="off" />
          </Field>
          <Field id="password" label="Password" hint="Stored encrypted; never shown again.">
            <Input id="password" name="password" type="password" autoComplete="new-password" />
          </Field>
        </div>
      )}
      {type === 'ses' && (
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="region" label="AWS region">
            <Input
              id="region"
              name="region"
              required
              placeholder="eu-central-1"
              className="font-mono"
            />
          </Field>
          <Field id="configurationSet" label="Configuration set" hint="Needed for delivery events.">
            <Input id="configurationSet" name="configurationSet" className="font-mono" />
          </Field>
          <Field
            id="topics"
            label="Allowed SNS topic ARNs"
            hint="Only signed notifications from these topics are accepted."
          >
            <Input id="topics" name="topics" className="font-mono" placeholder="arn:aws:sns:…" />
          </Field>
          <Field id="accessKeyId" label="Access key ID">
            <Input
              id="accessKeyId"
              name="accessKeyId"
              required
              autoComplete="off"
              className="font-mono"
            />
          </Field>
          <Field
            id="secretAccessKey"
            label="Secret access key"
            hint="Stored encrypted; never shown again."
          >
            <Input
              id="secretAccessKey"
              name="secretAccessKey"
              type="password"
              required
              autoComplete="new-password"
            />
          </Field>
        </div>
      )}
      <FormError message={error} />
      <div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save as default connection'}
        </Button>
      </div>
    </form>
  );
}

function ConnectionCard({ c, base }: { c: Connection; base: string }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = useAction(
    () =>
      api<{ ok: boolean; message: string }>(`${base}/providers/${c.id}/test`, {
        method: 'POST',
        body: {},
      }),
    { error: 'The connection test could not run', onSuccess: setResult },
  );
  const update = useAction(
    (body: unknown) => api(`${base}/providers/${c.id}`, { method: 'PATCH', body }),
    {
      success: 'Connection updated',
      error: 'Could not update the connection',
      invalidate: [`${base}/providers`],
    },
  );
  const remove = useAction(() => api(`${base}/providers/${c.id}`, { method: 'DELETE' }), {
    success: 'Connection removed',
    error: 'Could not remove it',
    invalidate: [`${base}/providers`],
  });
  return (
    <article className="rounded-md border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h3 className="font-medium">{c.name}</h3>
        <Pill>{c.type.toUpperCase()}</Pill>
        {c.isDefault && <Pill tone="info">Default</Pill>}
        {!c.enabled && <Pill tone="warning">Disabled</Pill>}
        {c.paused && (
          <Pill tone="danger" title={c.paused.reason ?? ''}>
            Paused by operator
          </Pill>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => test.mutate(undefined)}
            disabled={test.isPending}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          {!c.isDefault && (
            <Button size="sm" variant="outline" onClick={() => update.mutate({ isDefault: true })}>
              Make default
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => update.mutate({ enabled: !c.enabled })}>
            {c.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Confirm
            trigger={
              <Button size="sm" variant="ghost">
                Remove
              </Button>
            }
            title={`Remove ${c.name}?`}
            description="Queued emails that use it will fail at hand-off. The encrypted credentials are deleted."
            confirmLabel="Remove connection"
            onConfirm={() => remove.mutateAsync(undefined)}
          />
        </div>
      </header>
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <ul className="grid gap-1">
          {CAPS.map(([k, label]) => (
            <li key={k} className="flex items-center gap-2">
              <Pill tone={c.capabilities[k] ? 'success' : 'neutral'}>
                {c.capabilities[k] ? 'yes' : 'no'}
              </Pill>
              {label}
            </li>
          ))}
        </ul>
        <div className="grid content-start gap-1 text-muted-foreground">
          {Object.entries(c.config).map(([k, v]) => (
            <p key={k}>
              {k}: <Mono>{Array.isArray(v) ? v.join(', ') || '—' : String(v)}</Mono>
            </p>
          ))}
          <p>Credentials: {c.hasSecrets ? 'stored (encrypted)' : 'none'}</p>
          {c.eventsEndpoint && (
            <div className="mt-2">
              <p className="mb-1 text-foreground">SNS subscription endpoint (HTTPS)</p>
              <div className="flex items-center gap-1">
                <Mono className="break-all">{c.eventsEndpoint}</Mono>
                <CopyButton value={c.eventsEndpoint} />
              </div>
            </div>
          )}
        </div>
        {result && (
          <p
            role="status"
            className={`md:col-span-2 rounded-md border px-3 py-2 ${result.ok ? 'border-success/30 bg-success-soft text-success' : 'border-destructive/30 bg-danger-soft text-destructive'}`}
          >
            {result.message}
          </p>
        )}
      </div>
    </article>
  );
}

export default function ProvidersPage() {
  const { base } = useEnvScope();
  const list = useApi<{ localProviderAvailable: boolean; data: Connection[] }>(`${base}/providers`);
  return (
    <>
      <PageHeader
        title="Provider connections"
        description="The default connection sends this environment's email. OpenSend never switches providers on its own after an unclear hand-off."
      />
      <QueryView
        query={list}
        what="the provider connections"
        loading={<LoadingRows rows={2} cols={3} />}
      >
        {(l) => (
          <>
            {l.data.length === 0 ? (
              <div className="mb-8">
                <EmptyState title="No provider connected">
                  Connect{' '}
                  {l.localProviderAvailable
                    ? 'the local Mailpit provider for development, or '
                    : ''}
                  an SMTP relay or Amazon SES account.
                </EmptyState>
              </div>
            ) : (
              <div className="mb-8 grid gap-4">
                {l.data.map((c) => (
                  <ConnectionCard key={c.id} c={c} base={base} />
                ))}
              </div>
            )}
            <Section title="Add a connection">
              <AddConnection base={base} localAvailable={l.localProviderAvailable} />
            </Section>
          </>
        )}
      </QueryView>
    </>
  );
}
