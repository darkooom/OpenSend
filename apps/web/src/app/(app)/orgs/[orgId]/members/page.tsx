'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Field, FormError } from '@/components/auth-card';
import { Confirm } from '@/components/confirm';
import { OneTimeSecret } from '@/components/copy';
import { DataTable } from '@/components/data-table';
import { EmptyState, PageHeader, QueryView, Section } from '@/components/states';
import { Pill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useAction, useApi, useMe, useOrg } from '@/lib/hooks';
import { relative } from '@/lib/format';

interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
  projectAccess: 'all' | 'selected';
  projectIds: string[];
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  projectAccess: string;
  expiresAt: string;
  expired: boolean;
}
const ROLES = ['viewer', 'developer', 'admin', 'owner'] as const;
const ROLE_HELP: Record<string, string> = {
  viewer: 'Reads metadata, no message content, no changes',
  developer: 'Sends, reads content, manages domains, keys, templates, webhooks',
  admin: 'Plus members, providers, retention, export and audit log',
  owner: 'Full control including owners',
};

export default function MembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const me = useMe();
  const org = useOrg(orgId);
  const members = useApi<Member[]>(`/orgs/${orgId}/members`);
  const canManage = org.data && ['owner', 'admin'].includes(org.data.role);
  const invitations = useApi<Invitation[]>(canManage ? `/orgs/${orgId}/invitations` : null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<'all' | 'selected'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const remove = useAction(
    (id: string) => api(`/orgs/${orgId}/members/${id}`, { method: 'DELETE' }),
    {
      success: 'Member removed',
      error: 'Could not remove the member',
      invalidate: [`/orgs/${orgId}/members`],
    },
  );
  const revoke = useAction(
    (id: string) => api(`/orgs/${orgId}/invitations/${id}`, { method: 'DELETE' }),
    {
      success: 'Invitation revoked',
      error: 'Could not revoke the invitation',
      invalidate: [`/orgs/${orgId}/invitations`],
    },
  );
  const changeRole = useAction(
    (v: { id: string; role: string; m: Member }) =>
      api(`/orgs/${orgId}/members/${v.id}`, {
        method: 'PATCH',
        body: { role: v.role, projectAccess: v.m.projectAccess, projectIds: v.m.projectIds },
      }),
    {
      success: 'Role updated',
      error: 'Could not change the role',
      invalidate: [`/orgs/${orgId}/members`],
    },
  );
  const projectName = (id: string) =>
    org.data?.projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <PageHeader
        title="Members"
        description="Roles apply to the organization. Members can be limited to selected projects; they then see neither data nor totals of other projects."
      />
      {canManage && (
        <Section
          title="Invite someone"
          description="Invitations expire and can be used once. No email is sent: share the link yourself."
        >
          <form
            className="grid gap-4 rounded-md border bg-card p-4 md:grid-cols-[1fr_180px_auto] md:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setError(null);
              try {
                const r = await api<{ url: string }>(`/orgs/${orgId}/invitations`, {
                  method: 'POST',
                  body: {
                    email: f.get('email'),
                    role: f.get('role'),
                    projectAccess: access,
                    projectIds: access === 'selected' ? selected : [],
                  },
                });
                setLink(r.url);
                (e.target as HTMLFormElement).reset();
                await invitations.refetch();
              } catch (err) {
                setError(errorMessage(err, 'Could not create the invitation.'));
              }
            }}
          >
            <Field id="invite-email" label="Email">
              <Input id="invite-email" name="email" type="email" required />
            </Field>
            <Field id="invite-role" label="Role">
              <select
                id="invite-role"
                name="role"
                defaultValue="developer"
                className="h-9 rounded-md border border-input bg-card px-2"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit">Create invitation</Button>
            <fieldset className="md:col-span-3">
              <legend className="mb-1 font-medium">Project access</legend>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={access === 'all'}
                    onChange={() => setAccess('all')}
                  />{' '}
                  All projects
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={access === 'selected'}
                    onChange={() => setAccess('selected')}
                  />{' '}
                  Selected projects
                </label>
              </div>
              {access === 'selected' && (
                <div className="mt-2 flex flex-wrap gap-3">
                  {org.data?.projects.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selected.includes(p.id)}
                        onChange={(e) =>
                          setSelected((s) =>
                            e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id),
                          )
                        }
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <div className="md:col-span-3">
              <FormError message={error} />
              {link && <OneTimeSecret value={link} what="invitation link" />}
            </div>
          </form>
          <p className="mt-2 text-muted-foreground">
            {ROLES.map((r) => `${r}: ${ROLE_HELP[r]}`).join(' · ')}
          </p>
        </Section>
      )}
      <Section title="Members">
        <QueryView query={members} what="the members">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(m) => m.id}
              columns={[
                {
                  header: 'Name',
                  cell: (m) => (
                    <>
                      <p className="font-medium">{m.name}</p>
                      <p className="text-muted-foreground">{m.email}</p>
                    </>
                  ),
                },
                {
                  header: 'Role',
                  cell: (m) =>
                    canManage && m.email !== me.data?.user.email ? (
                      <select
                        aria-label={`Role of ${m.email}`}
                        value={m.role}
                        onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value, m })}
                        className="h-8 rounded-md border border-input bg-card px-2"
                      >
                        {ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    ) : (
                      <Pill>{m.role}</Pill>
                    ),
                },
                {
                  header: 'Projects',
                  cell: (m) =>
                    m.projectAccess === 'all'
                      ? 'All projects'
                      : m.projectIds.map(projectName).join(', '),
                },
                {
                  header: '',
                  className: 'text-right',
                  cell: (m) =>
                    canManage && m.email !== me.data?.user.email ? (
                      <Confirm
                        trigger={
                          <Button size="sm" variant="ghost">
                            Remove
                          </Button>
                        }
                        title={`Remove ${m.email}?`}
                        description="They lose access to this organization immediately. Their API keys stay valid until revoked."
                        confirmLabel="Remove member"
                        onConfirm={() => remove.mutateAsync(m.id)}
                      />
                    ) : null,
                },
              ]}
            />
          )}
        </QueryView>
      </Section>
      {canManage && (
        <Section title="Open invitations">
          <QueryView query={invitations} what="the invitations">
            {(rows) =>
              rows.length === 0 ? (
                <EmptyState title="No open invitations" />
              ) : (
                <DataTable
                  rows={rows}
                  rowKey={(i) => i.id}
                  columns={[
                    { header: 'Email', cell: (i) => i.email },
                    { header: 'Role', cell: (i) => <Pill>{i.role}</Pill> },
                    {
                      header: 'Expires',
                      cell: (i) =>
                        i.expired ? <Pill tone="warning">expired</Pill> : relative(i.expiresAt),
                    },
                    {
                      header: '',
                      className: 'text-right',
                      cell: (i) => (
                        <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                          Revoke
                        </Button>
                      ),
                    },
                  ]}
                />
              )
            }
          </QueryView>
        </Section>
      )}
    </>
  );
}
