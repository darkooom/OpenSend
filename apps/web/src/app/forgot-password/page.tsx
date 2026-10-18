'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthCard, Field, FormError } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ accountEmails: boolean }>('/setup/status').then(
      (s) => setAvailable(s.accountEmails),
      () => setAvailable(false),
    );
  }, []);

  if (available === false) {
    return (
      <AuthCard
        title="Password reset is not available"
        description="This installation has no sender for account emails. Ask an owner of your organization to remove and re-invite you, or ask the operator to configure the platform sender."
      >
        <Link href="/login" className="text-primary underline">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }
  if (sent) {
    return (
      <AuthCard
        title="Check your inbox"
        description="If an account exists for this address, we sent a link to reset the password. It is valid for one hour."
      >
        <Link href="/login" className="text-primary underline">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Reset your password" description="Enter the email address of your account.">
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/auth/request-password-reset', {
              method: 'POST',
              body: {
                email: new FormData(e.currentTarget).get('email'),
                redirectTo: `${location.origin}/reset-password`,
              },
            });
            setSent(true);
          } catch (err) {
            setError(errorMessage(err, 'The request failed. Try again in a minute.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        <FormError message={error} />
        <Button type="submit" disabled={busy || available === null}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
        <Link href="/login" className="text-muted-foreground hover:text-foreground">
          Back to sign in
        </Link>
      </form>
    </AuthCard>
  );
}
