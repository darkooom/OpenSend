'use client';

import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { HtmlPreview } from '@/components/html-preview';
import { ErrorState, LoadingRows, Mono, PageHeader, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction, useApi, useEnvScope } from '@/lib/hooks';

interface Variable {
  name: string;
  required: boolean;
  sample?: string;
  fallback?: string;
}
interface TemplateDetail {
  id: string;
  name: string;
  slug: string;
  draft: { subject: string; html: string | null; text: string | null; variables: Variable[] };
  latestVersion: number | null;
  versions: Array<{ id: string; version: number; subject: string; publishedAt: string }>;
}

export default function TemplateEditor() {
  const { base, projectId, envId } = useEnvScope();
  const { templateId } = useParams<{ templateId: string }>();
  const path = `${base}/templates/${templateId}`;
  const tpl = useApi<TemplateDetail>(path);
  const [draft, setDraft] = useState<TemplateDetail['draft'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    subject: string;
    html: string | null;
    text: string | null;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (tpl.data && !draft) setDraft(tpl.data.draft);
  }, [tpl.data, draft]);

  const save = useAction(
    () =>
      api(path, {
        method: 'PATCH',
        body: {
          subject: draft!.subject,
          html: draft!.html || null,
          text: draft!.text || null,
          variables: draft!.variables,
        },
      }),
    {
      success: 'Draft saved',
      error: 'The draft could not be saved',
      invalidate: [path],
      onSuccess: () => setError(null),
    },
  );
  const publish = useAction(
    () => api<{ version: number }>(`${path}/publish`, { method: 'POST', body: {} }),
    {
      success: (r) => `Published version ${r.version}`,
      error: 'Publishing failed',
      invalidate: [path, `${base}/templates`],
    },
  );
  const remove = useAction(() => api(path, { method: 'DELETE' }), {
    success: 'Template deleted',
    error: 'Could not delete it',
    onSuccess: () => (location.href = `/p/${projectId}/e/${envId}/templates`),
  });

  if (tpl.isLoading || !draft)
    return tpl.error ? (
      <ErrorState error={tpl.error} what="the template" onRetry={() => void tpl.refetch()} />
    ) : (
      <LoadingRows rows={6} cols={2} />
    );
  const t = tpl.data!;
  const dirty = JSON.stringify(draft) !== JSON.stringify(t.draft);
  const setVar = (i: number, patch: Partial<Variable>) =>
    setDraft({
      ...draft,
      variables: draft.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    });

  const runPreview = async () => {
    setPreviewError(null);
    try {
      // Saves first so the preview shows exactly what would be published.
      if (dirty) await save.mutateAsync(undefined);
      setPreview(await api(`${path}/preview`, { method: 'POST', body: {} }));
    } catch (err) {
      setPreviewError(errorMessage(err, 'The preview could not be rendered.'));
    }
  };

  return (
    <>
      <Link
        href={`/p/${projectId}/e/${envId}/templates`}
        className="mb-3 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Templates
      </Link>
      <PageHeader
        title={t.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Mono>template.id: “{t.slug}”</Mono>
            {t.latestVersion ? (
              <Pill tone="success">latest published v{t.latestVersion}</Pill>
            ) : (
              <Pill tone="warning">not published</Pill>
            )}
            {dirty && <Pill tone="warning">unsaved changes</Pill>}
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                save.mutate(undefined, {
                  onError: (err) => setError(errorMessage(err, 'Invalid template')),
                })
              }
              disabled={!dirty || save.isPending}
            >
              Save draft
            </Button>
            <Confirm
              trigger={<Button disabled={dirty}>Publish v{(t.latestVersion ?? 0) + 1}</Button>}
              destructive={false}
              title={`Publish version ${(t.latestVersion ?? 0) + 1}?`}
              description="New emails that reference this template without a version use it. Emails accepted earlier keep their rendered content."
              confirmLabel="Publish"
              onConfirm={() => publish.mutateAsync(undefined)}
            />
          </>
        }
      />
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          <Field id="subject" label="Subject">
            <Input
              id="subject"
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field
            id="html"
            label="HTML"
            hint="{{variable}} is HTML-escaped. Triple braces (unescaped) are not allowed."
          >
            <Textarea
              id="html"
              value={draft.html ?? ''}
              onChange={(e) => setDraft({ ...draft, html: e.target.value })}
              rows={12}
              className="font-mono text-[12.5px]"
            />
          </Field>
          <Field id="text" label="Plain text">
            <Textarea
              id="text"
              value={draft.text ?? ''}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              rows={5}
              className="font-mono text-[12.5px]"
            />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 font-medium">Variables</legend>
            {draft.variables.map((v, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
              >
                <Input
                  aria-label="Variable name"
                  value={v.name}
                  onChange={(e) => setVar(i, { name: e.target.value })}
                  className="font-mono"
                />
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={v.required}
                    onChange={(e) => setVar(i, { required: e.target.checked })}
                  />{' '}
                  required
                </label>
                <Input
                  aria-label="Sample value for previews"
                  placeholder="sample (preview)"
                  value={v.sample ?? ''}
                  onChange={(e) => setVar(i, { sample: e.target.value || undefined })}
                />
                <Input
                  aria-label="Fallback value"
                  placeholder="fallback"
                  value={v.fallback ?? ''}
                  onChange={(e) => setVar(i, { fallback: e.target.value || undefined })}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${v.name}`}
                  onClick={() =>
                    setDraft({ ...draft, variables: draft.variables.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft({
                    ...draft,
                    variables: [
                      ...draft.variables,
                      { name: `var${draft.variables.length + 1}`, required: true },
                    ],
                  })
                }
              >
                <Plus className="size-3.5" /> Add variable
              </Button>
            </div>
          </fieldset>
          <FormError message={error} />
        </div>
        <div className="grid content-start gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Preview</h2>
            <Button size="sm" variant="outline" onClick={runPreview}>
              Render with sample data
            </Button>
          </div>
          <FormError message={previewError} />
          {preview ? (
            <>
              <p>
                <span className="text-muted-foreground">Subject:</span> {preview.subject}
              </p>
              {preview.html && <HtmlPreview html={preview.html} />}
              {preview.text && (
                <pre className="whitespace-pre-wrap rounded-md border bg-card p-3 font-mono text-[12.5px]">
                  {preview.text}
                </pre>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              Render the draft to see it with the sample values.
            </p>
          )}
          <Section title="Published versions">
            {t.versions.length === 0 ? (
              <p className="text-muted-foreground">
                Nothing published yet. Sending with this template returns a validation error until
                you publish.
              </p>
            ) : (
              <ul className="rounded-md border bg-card">
                {t.versions.map((v) => (
                  <li key={v.id} className="flex justify-between border-b px-3 py-2 last:border-0">
                    <span>
                      <Pill>v{v.version}</Pill> {v.subject}
                    </span>
                    <span className="text-muted-foreground">{formatDate(v.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <div>
            <Confirm
              trigger={<Button variant="ghost">Delete template</Button>}
              title={`Delete ${t.name}?`}
              description="Emails already accepted keep their rendered content. New sends that reference it will fail."
              confirmLabel="Delete template"
              typeToConfirm={t.slug}
              onConfirm={() => remove.mutateAsync(undefined)}
            />
          </div>
        </div>
      </div>
    </>
  );
}
