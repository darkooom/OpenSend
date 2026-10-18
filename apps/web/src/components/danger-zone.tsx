'use client';

import { useState } from 'react';
import { Confirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';

/** A destructive scope deletion with typed confirmation and an explicit "cancel waiting emails" choice. */
export function DeleteScope({
  label,
  name,
  path,
  consequences,
  onDeleted,
}: {
  label: string;
  name: string;
  path: string;
  consequences: string;
  onDeleted: () => void;
}) {
  const [cancelPending, setCancelPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 last:border-0">
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">{consequences}</p>
        {error && (
          <p role="alert" className="mt-1 text-destructive">
            {error}
          </p>
        )}
      </div>
      <Confirm
        trigger={
          <Button
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-danger-soft"
          >
            {label}
          </Button>
        }
        title={`${label}?`}
        description={
          <div className="grid gap-3">
            <p>{consequences} This cannot be undone.</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={cancelPending}
                onChange={(e) => setCancelPending(e.target.checked)}
              />
              <span>
                Cancel emails that are still waiting to be sent. Without this, deletion is refused
                while emails are pending.
              </span>
            </label>
          </div>
        }
        confirmLabel={label}
        typeToConfirm={name}
        onConfirm={async () => {
          setError(null);
          try {
            await api(`${path}${cancelPending ? '?cancelPending=true' : ''}`, { method: 'DELETE' });
            onDeleted();
          } catch (err) {
            setError(errorMessage(err, 'Deletion failed. Nothing was deleted.'));
          }
        }}
      />
    </div>
  );
}
