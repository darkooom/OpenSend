'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { EmptyState, LoadingRows, PageHeader, QueryView } from '@/components/states';
import { EnvBadge, Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useOrg } from '@/lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@/lib/types';

function CreateProject({ orgId }: { orgId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prod, setProd] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is the boundary for one customer or product: its own domains, keys, providers
            and data.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get('name'));
            setBusy(true);
            setError(null);
            try {
              const envs = [
                { name: 'development', kind: 'development' },
                ...(prod ? [{ name: 'production', kind: 'production' }] : []),
              ];
              const p = await api<Project>(`/orgs/${orgId}/projects`, {
                method: 'POST',
                body: { name, environments: envs },
              });
              await qc.invalidateQueries({ queryKey: ['api', `/orgs/${orgId}`] });
              router.push(`/p/${p.id}/e/${p.environments[0]!.id}`);
            } catch (err) {
              setError(errorMessage(err, 'Could not create the project.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            id="project-name"
            label="Project name"
            hint="Usually the customer or product name."
          >
            <Input id="project-name" name="name" required maxLength={100} autoFocus />
          </Field>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={prod}
              onChange={(e) => setProd(e.target.checked)}
            />
            <span>
              Also create a <strong>production</strong> environment
              <span className="block text-muted-foreground">
                A development environment is always created; it can use the local Mailpit provider.
              </span>
            </span>
          </label>
          <FormError message={error} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function OrgPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const org = useOrg(orgId);
  const canCreate = org.data && ['owner', 'admin'].includes(org.data.role);
  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project keeps a customer's domains, keys, providers and email data separate."
        actions={canCreate ? <CreateProject orgId={orgId} /> : null}
      />
      <QueryView query={org} what="the projects" loading={<LoadingRows rows={3} cols={3} />}>
        {(o) =>
          o.projects.length === 0 ? (
            <EmptyState
              title="No projects yet"
              action={canCreate ? <CreateProject orgId={orgId} /> : undefined}
            >
              {canCreate
                ? 'Create a project for your first customer or product. Next you connect a provider, add a domain and send a test email.'
                : 'You have not been given access to any project. Ask an admin of this organization.'}
            </EmptyState>
          ) : (
            <ul className="grid gap-px overflow-hidden rounded-md border bg-border">
              {o.projects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 bg-card px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{p.name}</p>
                    <p className="font-mono text-[12px] text-muted-foreground">{p.id}</p>
                  </div>
                  {p.paused && <Pill tone="danger">Paused</Pill>}
                  <div className="flex flex-wrap gap-1.5">
                    {p.environments.map((e) => (
                      <Link
                        key={e.id}
                        href={`/p/${p.id}/e/${e.id}`}
                        className="rounded-sm hover:opacity-80"
                      >
                        <EnvBadge kind={e.kind} name={e.name} />
                      </Link>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </>
  );
}
