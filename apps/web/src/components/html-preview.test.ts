import { describe, expect, it } from 'vitest';
import { PREVIEW_SANDBOX, previewDocument } from './html-preview';

describe('previewDocument', () => {
  it('blocks scripts and remote images by default', () => {
    const doc = previewDocument(
      '<img src="https://tracker.example/p.gif"><script>alert(1)</script>',
      false,
    );
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain('img-src data:');
    expect(doc).not.toContain('img-src https:');
  });
  it('allows remote images only on request', () => {
    expect(previewDocument('<p>x</p>', true)).toContain('img-src https:');
  });
  it('uses an empty sandbox (no allow-scripts, no allow-same-origin)', () => {
    expect(PREVIEW_SANDBOX).toBe('');
  });
});
