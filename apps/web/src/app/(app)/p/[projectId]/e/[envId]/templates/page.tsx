'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { DataTable } from '@/components/data-table';
import { EmptyState, LoadingRows, Mono, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { relative } from '@/lib/format';
import { useApi, useEnvScope } from '@/lib/hooks';

interface Template {
  id: string;
  name: string;
  slug: string;
  latestVersion: number | null;
  updatedAt: string;
}

export default function TemplatesPage() {
  const { base, projectId, envId } = useEnvScope();
  const router = useRouter();
  const list = useApi<Template[]>(`${base}/templates`);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Templates"
        description="Edit a draft, preview it with test data, publish an immutable version. Accepted emails keep the version they were rendered with."
      />
      <Section title="New template">
        <form
          className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setError(null);
            try {
              const t = await api<Template>(`${base}/templates`, {
                method: 'POST',
                body: {
                  name: f.get('name'),
                  slug: f.get('slug'),
                  subject: 'Hello {{name}}',
                  html: '<p>Hello {{name}},</p>',
                  text: 'Hello {{name}},',
                  variables: [{ name: 'name', required: true, sample: 'Ada' }],
                },
              });
              router.push(`/p/${projectId}/e/${envId}/templates/${t.id}`);
            } catch (err) {
              setError(errorMessage(err, 'Could not create the template.'));
            }
          }}
        >
          <Field id="tpl-name" label="Name">
            <Input id="tpl-name" name="name" required className="w-64" />
          </Field>
          <Field id="tpl-slug" label="Slug" hint="Used in the API: template.id">
            <Input
              id="tpl-slug"
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="welcome"
              className="w-48 font-mono"
            />
          </Field>
          <Button type="submit">Create draft</Button>
          <div className="basis-full">
            <FormError message={error} />
          </div>
        </form>
      </Section>
      <QueryView query={list} what="the templates" loading={<LoadingRows rows={3} cols={4} />}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No templates yet">
              Templates are optional. You can always send subject, HTML and text directly.
            </EmptyState>
          ) : (
            <DataTable
              rows={rows}
              rowKey={(t) => t.id}
              onRowClick={(t) => router.push(`/p/${projectId}/e/${envId}/templates/${t.id}`)}
              columns={[
                { header: 'Name', cell: (t) => <span className="font-medium">{t.name}</span> },
                { header: 'Slug', cell: (t) => <Mono>{t.slug}</Mono> },
                {
                  header: 'Published',
                  cell: (t) =>
                    t.latestVersion ? (
                      <Pill tone="success">v{t.latestVersion}</Pill>
                    ) : (
                      <Pill tone="warning">draft only</Pill>
                    ),
                },
                { header: 'Updated', cell: (t) => relative(t.updatedAt) },
              ]}
            />
          )
        }
      </QueryView>
    </>
  );
}
