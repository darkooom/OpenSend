'use client';

import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { ErrorState, LoadingRows, PageHeader, Section } from '@/components/states';
import { DeleteScope } from '@/components/danger-zone';
import { EnvBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useAction, useApi, useEnvScope, useProject } from '@/lib/hooks';
import type { UsageResponse } from '@/lib/types';

export default function SettingsPage() {
  const { base, projectId, envId } = useEnvScope();
  const project = useProject(projectId);
  const usage = useApi<UsageResponse>(`/projects/${projectId}/usage`);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const saveRetention = useAction(
    (body: unknown) => api(`/projects/${projectId}/retention`, { method: 'PATCH', body }),
    {
      success: 'Retention policy saved',
      error: 'Could not save the policy',
      invalidate: [`/projects/${projectId}`],
    },
  );
  const addEnv = useAction(
    (body: unknown) => api(`/projects/${projectId}/environments`, { method: 'POST', body }),
    {
      success: 'Environment created',
      error: 'Could not create the environment',
      invalidate: [`/projects/${projectId}`],
    },
  );

  if (project.isLoading) return <LoadingRows rows={4} cols={2} />;
  if (!project.data)
    return (
      <ErrorState error={project.error} what="the project" onRetry={() => void project.refetch()} />
    );
  const p = project.data;
  const env = p.environments.find((e) => e.id === envId);
  return (
    <>
      <PageHeader title="Project settings" description={p.name} />
      <Section
        title="Environments"
        description="Keys, domains, providers and data are separate per environment."
      >
        <ul className="mb-3 flex flex-wrap gap-2">
          {p.environments.map((e) => (
            <li key={e.id}>
              <a href={`/p/${projectId}/e/${e.id}`}>
                <EnvBadge kind={e.kind} name={e.name} />
              </a>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setEnvError(null);
            try {
              await addEnv.mutateAsync({ name: f.get('name'), kind: f.get('kind') });
              form.reset();
            } catch (err) {
              setEnvError(errorMessage(err, 'Could not create the environment.'));
            }
          }}
        >
          <Field id="env-name" label="Name">
            <Input id="env-name" name="name" required placeholder="staging" className="w-48" />
          </Field>
          <Field id="env-kind" label="Kind">
            <select
              id="env-kind"
              name="kind"
              className="h-9 rounded-md border border-input bg-card px-2"
            >
              <option value="development">development</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </select>
          </Field>
          <Button type="submit">Add environment</Button>
          <div className="basis-full">
            <FormError message={envError} />
          </div>
        </form>
      </Section>

      <Section
        title="Data retention"
        description="What OpenSend keeps after an email reached its final state. Applies to every environment of this project."
      >
        <form
          className="grid gap-4 rounded-md border bg-card p-4 md:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setRetentionError(null);
            try {
              await saveRetention.mutateAsync({
                contentDays: Number(f.get('content')),
                attachmentDays: Number(f.get('attachments')),
                eventDays: Number(f.get('events')),
              });
            } catch (err) {
              setRetentionError(errorMessage(err, 'Could not save the policy.'));
            }
          }}
        >
          <Field
            id="ret-content"
            label="Message content (days)"
            hint="0 = no long-term content archive: content is deleted right after the final hand-off."
          >
            <Input
              id="ret-content"
              name="content"
              type="number"
              min={0}
              max={3650}
              defaultValue={p.retention.contentDays}
            />
          </Field>
          <Field
            id="ret-attachments"
            label="Attachments (days)"
            hint="Stored encrypted in object storage until then."
          >
            <Input
              id="ret-attachments"
              name="attachments"
              type="number"
              min={0}
              max={3650}
              defaultValue={p.retention.attachmentDays}
            />
          </Field>
          <Field
            id="ret-events"
            label="Metadata & events (days)"
            hint="Recipients, status history, attempts. Then the email record is deleted."
          >
            <Input
              id="ret-events"
              name="events"
              type="number"
              min={1}
              max={3650}
              defaultValue={p.retention.eventDays}
            />
          </Field>
          <p className="text-muted-foreground md:col-span-3">
            Until the final state, content is kept encrypted because it is needed for hand-off and
            retries; emails with an unknown outcome keep it for at least 7 days. Backups, the
            sending provider and receivers keep their own copies under their own rules.
          </p>
          <FormError message={retentionError} />
          <div className="md:col-span-3">
            <Button type="submit" disabled={saveRetention.isPending}>
              Save policy
            </Button>
          </div>
        </form>
      </Section>

      <Section title="Usage and limits">
        {usage.data ? (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-4">
            {[
              [
                'Recipients this month',
                `${usage.data.acceptedRecipients} / ${usage.data.quota.recipients}`,
              ],
              ['Emails this month', usage.data.acceptedEmails],
              ['Pending (all environments)', usage.data.pending],
              ['Max recipients per email', usage.data.limits.maxRecipientsPerEmail],
              ['Attachments per email', bytes(usage.data.limits.maxAttachmentBytes)],
              ['Schedule ahead', `${usage.data.limits.maxScheduleDays} days`],
              ['Batch size', usage.data.limits.maxBatchSize],
              ['API rate limit', `${usage.data.limits.rateLimitPerMinute}/min per key`],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-card px-4 py-3">
                <dt className="text-[12px] text-muted-foreground">{k}</dt>
                <dd className="font-mono tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <LoadingRows rows={1} cols={4} />
        )}
      </Section>

      <Section
        title="Export"
        description={
          <>
            Download email metadata, recipients and events of{' '}
            {env && <EnvBadge kind={env.kind} name={env.name} />} as NDJSON. Message content is not
            included.
          </>
        }
      >
        <Button asChild variant="outline">
          <a href={`/api${base}/export`} download>
            Download export
          </a>
        </Button>
      </Section>

      {['owner', 'admin'].includes(p.role ?? '') && (
        <Section
          title="Danger zone"
          description="Deletes data, attachment objects and keys. Emails being handed off right now block deletion."
        >
          <div className="rounded-md border border-destructive/30 bg-card">
            {env && p.environments.length > 1 && (
              <DeleteScope
                label="Delete this environment"
                name={env.name}
                path={`/projects/${projectId}/environments/${envId}`}
                consequences={`Removes the ${env.name} environment with its emails, domains, keys, providers, templates and webhooks.`}
                onDeleted={() =>
                  (location.href = `/p/${projectId}/e/${p.environments.find((e) => e.id !== envId)!.id}`)
                }
              />
            )}
            <DeleteScope
              label="Delete this project"
              name={p.name}
              path={`/projects/${projectId}`}
              consequences="Removes every environment of this project with all its data and attachments."
              onDeleted={() => (location.href = `/orgs/${p.organizationId}`)}
            />
          </div>
        </Section>
      )}
    </>
  );
}
