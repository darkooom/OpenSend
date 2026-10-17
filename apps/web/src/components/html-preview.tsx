'use client';

import { ImageOff, Image as ImageIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Builds the document for an untrusted email preview. Protection is layered:
 *  - the iframe has `sandbox=""` (no scripts, no forms, opaque origin, no top navigation),
 *  - a CSP inside the document blocks scripts and – unless the viewer opts in – remote images,
 *  - all links open nowhere (base target is blocked by the sandbox).
 */
export function previewDocument(html: string, allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? 'img-src https: data: cid:' : 'img-src data:';
  const csp = `default-src 'none'; ${img}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; script-src 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{margin:16px;font-family:system-ui,sans-serif;color:#151513;background:#fff}</style></head><body>${html}</body></html>`;
}

export const PREVIEW_SANDBOX = '';

export function HtmlPreview({ html }: { html: string }) {
  const [images, setImages] = useState(false);
  const doc = useMemo(() => previewDocument(html, images), [html, images]);
  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-muted-foreground">
        <span>
          {images
            ? 'Remote images are loaded.'
            : 'Remote images are blocked for privacy (they can track opens).'}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setImages((v) => !v)}>
          {images ? <ImageOff className="size-3.5" /> : <ImageIcon className="size-3.5" />}
          {images ? 'Block images' : 'Load images'}
        </Button>
      </div>
      <iframe
        title="Email HTML preview"
        sandbox={PREVIEW_SANDBOX}
        srcDoc={doc}
        referrerPolicy="no-referrer"
        className="h-[480px] w-full rounded-b-md bg-white"
        data-testid="html-preview"
      />
    </div>
  );
}
