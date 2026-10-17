'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={label}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** A secret that is shown exactly once (API keys, webhook secrets). */
export function OneTimeSecret({ value, what }: { value: string; what: string }) {
  return (
    <div className="rounded-md border border-warning/30 bg-warning-soft p-3">
      <p className="mb-2 font-medium">Copy this {what} now. It will not be shown again.</p>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 select-all break-all rounded-sm border bg-card px-2 py-1.5 font-mono text-[12.5px]"
          data-testid="one-time-secret"
        >
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
