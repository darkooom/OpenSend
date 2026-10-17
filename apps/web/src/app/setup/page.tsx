'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthCard, Field, FormError } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

export default function SetupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    api<{ needsSetup: boolean }>('/setup/status').then(
      (s) => setClosed(!s.needsSetup),
      () => undefined,
    );
  }, []);
  if (closed) {
    return (
      <AuthCard
        title="Setup is complete"
        description="This installation already has an owner. Ask them for an invitation."
      >
        <Button onClick={() => router.replace('/login')}>Go to sign in</Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Set up OpenSend"
      description={
        <>
          Create the first owner. Generate a one-time setup token on the server with{' '}
          <code className="font-mono">pnpm bootstrap:token</code>.
        </>
      }
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
            await api('/setup', {
              method: 'POST',
              body: {
                token: String(f.get('token')).trim(),
                organizationName: f.get('organizationName'),
                name: f.get('name'),
                email: f.get('email'),
                password: f.get('password'),
              },
            });
            await api('/auth/sign-in/email', {
              method: 'POST',
              body: { email: f.get('email'), password: f.get('password') },
            });
            router.replace('/');
          } catch (err) {
            setError(
              errorMessage(
                err,
                'Setup failed. Check the token (it expires after 60 minutes) and try again.',
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field id="token" label="Setup token" hint="Valid for 60 minutes and usable once.">
          <Input id="token" name="token" required autoComplete="off" className="font-mono" />
        </Field>
        <Field
          id="organizationName"
          label="Organization name"
          hint="Your agency or company. Customer projects live inside it."
        >
          <Input id="organizationName" name="organizationName" required minLength={2} />
        </Field>
        <Field id="name" label="Your name">
          <Input id="name" name="name" required autoComplete="name" />
        </Field>
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field id="password" label="Password" hint="At least 12 characters.">
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
        </Field>
        <Field id="password2" label="Repeat password">
          <Input
            id="password2"
            name="password2"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
        </Field>
        <FormError message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating owner…' : 'Create owner and sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}
