import path from 'node:path';
import type { NextConfig } from 'next';

const api = process.env.OPENSEND_API_INTERNAL_URL ?? 'http://localhost:3001';

// Message HTML is only rendered inside sandboxed iframes (srcdoc, no scripts), so the
// dashboard itself can run under a strict policy.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" +
    (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' about:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  poweredByHeader: false,
  transpilePackages: ['@opensend/contracts'],
  async rewrites() {
    // Same-origin proxy: session cookies stay first-party and CSRF checks see our origin.
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/v1/openapi.json', destination: `${api}/v1/openapi.json` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
