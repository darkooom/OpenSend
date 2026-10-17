'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthCard, Field, FormError } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

interface Invitation {
  organizationName: string;
  email: string;
  role: string;
  expiresAt: string;
  accountExists: boolean;
}

export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [inv, setInv] = useState<Invitation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('token');
    setToken(t);
    if (!t) return setLoadError('This invitation link is incomplete.');
    api<Invitation>(`/invitations/lookup?token=${encodeURIComponent(t)}`).then(setInv, (err) =>
      setLoadError(errorMessage(err, 'This invitation is not valid.')),
    );
  }, []);
  if (loadError) {
    return (
      <AuthCard
        title="Invitation not available"
        description={`${loadError} Invitations expire and can only be used once. Ask for a new one.`}
      >
        <Button variant="outline" onClick={() => router.replace('/login')}>
          Go to sign in
        </Button>
      </AuthCard>
    );
  }
  if (!inv) return <AuthCard title="Checking invitation…">{null}</AuthCard>;
  const accept = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api('/invitations/accept', { method: 'POST', body: { token, ...body } });
      if (!inv.accountExists)
        await api('/auth/sign-in/email', {
          method: 'POST',
          body: { email: inv.email, password: body.password },
        });
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err, 'Could not accept the invitation.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title={`Join ${inv.organizationName}`}
      description={
        <>
          You were invited as <strong>{inv.role}</strong> with{' '}
          <span className="font-mono">{inv.email}</span>.
        </>
      }
    >
      {inv.accountExists ? (
        <div className="grid gap-3">
          <p className="text-muted-foreground">
            You already have an account. Sign in as {inv.email} first, then open this link again.
          </p>
          <FormError message={error} />
          <Button disabled={busy} onClick={() => accept({})}>
            Accept invitation
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              router.push(`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`)
            }
          >
            Sign in
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void accept({ name: f.get('name'), password: f.get('password') });
          }}
        >
          <Field id="name" label="Your name">
            <Input id="name" name="name" required autoComplete="name" />
          </Field>
          <Field id="password" label="Choose a password" hint="At least 12 characters.">
            <Input
              id="password"
              name="password"
              type="password"
              minLength={12}
              required
              autoComplete="new-password"
            />
          </Field>
          <FormError message={error} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account and join'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
