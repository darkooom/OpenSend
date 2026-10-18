'use client';

import {
  Activity,
  BookText,
  Building2,
  ChevronsUpDown,
  FileCode2,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  Plug,
  ScrollText,
  Settings,
  ShieldBan,
  ShieldCheck,
  Users,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { EnvBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, ApiError } from '@/lib/api';
import { useApi, useMe, useOrg, useProject } from '@/lib/hooks';
import { cn } from '@/lib/utils';

function NavLink({
  href,
  icon: Icon,
  children,
  exact,
}: {
  href: string;
  icon: typeof Mail;
  children: ReactNode;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground',
        active && 'bg-secondary font-medium text-primary',
      )}
    >
      <Icon className="size-4 shrink-0" />
      {children}
    </Link>
  );
}

function VerifyEmailBanner({ email }: { email: string }) {
  const status = useApi<{ accountEmails: boolean }>('/setup/status');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  if (!status.data?.accountEmails) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-warning/25 bg-warning-soft px-6 py-2 text-warning"
    >
      <span>
        Confirm your email address <span className="font-mono">{email}</span> so password reset can
        reach you.
      </span>
      {state === 'sent' ? (
        <span>Link sent. Check your inbox.</span>
      ) : (
        <button
          type="button"
          className="font-medium underline disabled:opacity-60"
          disabled={state === 'sending'}
          onClick={async () => {
            setState('sending');
            try {
              await api('/auth/send-verification-email', {
                method: 'POST',
                body: { email, callbackURL: `${location.origin}/` },
              });
              setState('sent');
            } catch {
              setState('error');
            }
          }}
        >
          {state === 'error' ? 'Sending failed, try again' : 'Send confirmation link'}
        </button>
      )}
    </div>
  );
}

/** Authenticated application frame. Project + environment are always visible to avoid acting on the wrong one. */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const params = useParams<{ orgId?: string; projectId?: string; envId?: string }>();
  const me = useMe();
  const project = useProject(params.projectId);
  const orgId =
    params.orgId ?? project.data?.organizationId ?? me.data?.memberships[0]?.organization.id;
  const org = useOrg(orgId);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      router.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
  }, [me.error, router]);

  if (me.isLoading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!me.data) return <div className="p-8 text-muted-foreground">Redirecting to sign in…</div>;

  const env = project.data?.environments.find((e) => e.id === params.envId);
  const envBase =
    params.projectId && params.envId ? `/p/${params.projectId}/e/${params.envId}` : null;
  const currentOrg = me.data.memberships.find((m) => m.organization.id === orgId);

  const navItems = (
    <>
      {envBase && (
        <div className="mb-4 grid gap-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Environment
          </p>
          <NavLink href={envBase} icon={LayoutDashboard} exact>
            Overview
          </NavLink>
          <NavLink href={`${envBase}/emails`} icon={Mail}>
            Emails
          </NavLink>
          <NavLink href={`${envBase}/templates`} icon={FileCode2}>
            Templates
          </NavLink>
          <NavLink href={`${envBase}/domains`} icon={Globe}>
            Domains
          </NavLink>
          <NavLink href={`${envBase}/providers`} icon={Plug}>
            Providers
          </NavLink>
          <NavLink href={`${envBase}/api-keys`} icon={KeyRound}>
            API keys
          </NavLink>
          <NavLink href={`${envBase}/webhooks`} icon={Webhook}>
            Webhooks
          </NavLink>
          <NavLink href={`${envBase}/suppressions`} icon={ShieldBan}>
            Suppressions
          </NavLink>
          <NavLink href={`${envBase}/settings`} icon={Settings}>
            Project settings
          </NavLink>
        </div>
      )}
      {orgId && (
        <div className="grid gap-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Organization
          </p>
          <NavLink href={`/orgs/${orgId}`} icon={Building2} exact>
            Projects
          </NavLink>
          <NavLink href={`/orgs/${orgId}/members`} icon={Users}>
            Members
          </NavLink>
          <NavLink href={`/orgs/${orgId}/audit`} icon={ScrollText}>
            Audit log
          </NavLink>
        </div>
      )}
      {me.data.user.platformRole === 'admin' && (
        <div className="mt-4 grid gap-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Instance
          </p>
          <NavLink href="/admin" icon={ShieldCheck}>
            Operator
          </NavLink>
        </div>
      )}
      <div className="mt-4 grid gap-0.5">
        <a
          href="/v1/openapi.json"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <BookText className="size-4" /> OpenAPI spec
        </a>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-card md:flex">
        <div className="border-b px-3 py-3">
          <p className="mb-2 font-mono text-[13px] font-medium text-primary">opensend</p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-between">
                <span className="truncate">{currentOrg?.organization.name ?? 'Organization'}</span>
                <ChevronsUpDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {me.data.memberships.map((m) => (
                <DropdownMenuItem
                  key={m.organization.id}
                  onSelect={() => router.push(`/orgs/${m.organization.id}`)}
                >
                  {m.organization.name}
                  <span className="ml-auto text-muted-foreground">{m.role}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
          {navItems}
        </nav>
        <div className="border-t px-3 py-2">
          <p className="truncate text-[12px] text-muted-foreground" title={me.data.user.email}>
            {me.data.user.email}
          </p>
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={async () => {
              await api('/auth/sign-out', { method: 'POST', body: {} }).catch(() => undefined);
              router.replace('/login');
            }}
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <details className="border-b bg-card md:hidden">
          <summary className="flex cursor-pointer items-center justify-between px-4 py-3">
            <span className="font-mono text-[13px] font-medium text-primary">opensend</span>
            <span className="text-muted-foreground">Menu</span>
          </summary>
          <nav className="grid gap-0.5 px-2 pb-3" aria-label="Main (mobile)">
            {navItems}
          </nav>
        </details>
        {project.data && (
          <header
            className={cn(
              'flex flex-wrap items-center gap-2 border-b bg-card px-6 py-2.5',
              env?.kind === 'production' && 'border-b-production/40',
            )}
          >
            <Link
              href={`/orgs/${project.data.organizationId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {org.data?.organization.name ?? 'Organization'}
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium">{project.data.name}</span>
            <span className="text-muted-foreground">/</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1"
                  aria-label="Switch environment"
                >
                  {env ? <EnvBadge kind={env.kind} name={env.name} /> : 'Environment'}
                  <ChevronsUpDown className="size-3.5 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Environments</DropdownMenuLabel>
                {project.data.environments.map((e) => (
                  <DropdownMenuItem
                    key={e.id}
                    onSelect={() => router.push(`/p/${project.data!.id}/e/${e.id}`)}
                  >
                    <EnvBadge kind={e.kind} name={e.name} />
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => router.push(`/p/${project.data!.id}/e/${params.envId}/settings`)}
                >
                  Manage environments
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {project.data.paused && (
              <span className="ml-auto flex items-center gap-1.5 text-destructive">
                <Activity className="size-3.5" /> Sending paused by the operator
              </span>
            )}
          </header>
        )}
        {!me.data.user.emailVerified && <VerifyEmailBanner email={me.data.user.email} />}
        <main className="mx-auto max-w-[1200px] px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
