'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthCard, Field, FormError } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setToken(q.get('error') ? null : q.get('token'));
  }, []);
  if (token === undefined) return <AuthCard title="Reset your password">{null}</AuthCard>;
  if (token === null) {
    return (
      <AuthCard
        title="This link is no longer valid"
        description="Reset links expire after one hour and work once."
      >
        <Link href="/forgot-password" className="text-primary underline">
          Request a new link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Choose a new password"
      description="All your existing sessions are signed out afterwards."
    >
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (f.get('password') !== f.get('password2'))
            return setError('The passwords do not match.');
          setBusy(true);
          setError(null);
          try {
            await api('/auth/reset-password', {
              method: 'POST',
              body: { newPassword: f.get('password'), token },
            });
            router.replace('/login?reset=1');
          } catch (err) {
            setError(errorMessage(err, 'The password could not be changed. Request a new link.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field id="password" label="New password" hint="At least 12 characters.">
          <Input
            id="password"
            name="password"
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
            autoFocus
          />
        </Field>
        <Field id="password2" label="Repeat new password">
          <Input
            id="password2"
            name="password2"
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
          />
        </Field>
        <FormError message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    </AuthCard>
  );
}
