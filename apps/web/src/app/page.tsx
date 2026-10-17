'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorState } from '@/components/states';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';

/** Entry: route to setup (fresh install), sign-in, or the user's first organization. */
export default function Home() {
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    (async () => {
      try {
        const setup = await api<{ needsSetup: boolean }>('/setup/status');
        if (setup.needsSetup) return router.replace('/setup');
        const me = await api<Me>('/me');
        const first = me.memberships[0];
        router.replace(first ? `/orgs/${first.organization.id}` : '/no-access');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
        else setError(err);
      }
    })();
  }, [router]);
  return (
    <main className="p-8">
      {error ? (
        <ErrorState error={error} what="your workspace" onRetry={() => location.reload()} />
      ) : (
        <p className="text-muted-foreground">Loading…</p>
      )}
    </main>
  );
}
