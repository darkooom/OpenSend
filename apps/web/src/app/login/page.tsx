'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthCard, Field, FormError } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('reset'))
      setNotice('Your password was changed. Sign in with the new one.');
  }, []);
  return (
    <AuthCard
      title="Sign in"
      description="Accounts are created by invitation from your organization."
    >
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError(null);
          try {
            await api('/auth/sign-in/email', {
              method: 'POST',
              body: { email: f.get('email'), password: f.get('password') },
            });
            const next = new URLSearchParams(location.search).get('next');
            router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
          } catch (err) {
            setError(errorMessage(err, 'Sign-in failed. Check your email and password.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        <Field id="password" label="Password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        {notice && (
          <p
            role="status"
            className="rounded-md border border-success/30 bg-success-soft px-3 py-2 text-success"
          >
            {notice}
          </p>
        )}
        <FormError message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground">
          Forgot your password?
        </Link>
      </form>
    </AuthCard>
  );
}
