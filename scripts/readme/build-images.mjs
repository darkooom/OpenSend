#!/usr/bin/env node
// Turns docs/readme/raw/*.png into the README images (WebP), plus a hero, a phone collage and an
// animated tour. Needs `cwebp` and `img2webp` (libwebp) and Playwright's Chromium.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const raw = path.join(root, 'docs/readme/raw');
const out = path.join(root, 'docs/readme');
const tmp = path.join(raw, '.tmp');
mkdirSync(tmp, { recursive: true });

const webp = (src, dest, width = 2000, q = 82) =>
  execFileSync('cwebp', [
    '-quiet',
    '-q',
    String(q),
    '-resize',
    String(width),
    '0',
    src,
    '-o',
    dest,
  ]);
const dataUrl = (file) =>
  `data:image/png;base64,${readFileSync(path.join(raw, file)).toString('base64')}`;

// 1. every screenshot
for (const f of readdirSync(raw).filter((f) => f.endsWith('.png') && !f.startsWith('mobile-'))) {
  webp(path.join(raw, f), path.join(out, f.replace(/\.png$/, '.webp')));
}

const browser = await chromium.launch();
const render = async (html, width, height, file) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(tmp, file) });
  await page.close();
};
const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">`;
const base = `*{box-sizing:border-box;margin:0}body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:#151513;background:#fafaf7}`;

// 2. hero: claim on the left, product on the right
await render(
  `<!doctype html><html><head>${fonts}<style>${base}
  .wrap{display:grid;grid-template-columns:520px 1fr;gap:56px;align-items:center;height:100vh;padding:0 0 0 72px;overflow:hidden;background:linear-gradient(180deg,#fafaf7,#f1f0eb);border-bottom:1px solid #e3e1d9}
  .brand{font-family:'IBM Plex Mono',monospace;color:#0e6b5c;font-size:20px;margin-bottom:28px}
  h1{font-size:52px;line-height:1.08;letter-spacing:-0.02em;font-weight:600}
  p{margin-top:20px;font-size:20px;line-height:1.5;color:#6b6a63}
  .chips{margin-top:28px;display:flex;flex-wrap:wrap;gap:8px}
  .chips span{border:1px solid #e3e1d9;background:#fff;border-radius:6px;padding:4px 10px;font-size:15px}
  .shot{border:1px solid #d6d3c9;border-radius:10px 0 0 10px;overflow:hidden;width:1150px;box-shadow:0 30px 60px -30px rgba(21,21,19,.25)}
  .shot img{display:block;width:100%}
  </style></head><body><div class="wrap"><div>
  <div class="brand">opensend</div>
  <h1>Transactional email you can run yourself.</h1>
  <p>Real project separation for every customer, retention you control, and the sending provider of your choice.</p>
  <div class="chips"><span>Self-hosted</span><span>Bring your own provider</span><span>Per-project data</span><span>Signed webhooks</span></div>
  </div><div class="shot"><img src="${dataUrl('emails.png')}"></div></div></body></html>`,
  1600,
  760,
  'hero.png',
);
webp(path.join(tmp, 'hero.png'), path.join(out, 'hero.webp'), 2400, 85);

// 3. phones
await render(
  `<!doctype html><html><head>${fonts}<style>${base}
  .row{display:flex;gap:48px;justify-content:center;align-items:center;height:100vh;background:#f1f0eb}
  .phone{width:300px;border:10px solid #151513;border-radius:44px;overflow:hidden;background:#151513}
  .phone img{display:block;width:100%;border-radius:34px}
  .phone:nth-child(2){transform:translateY(-24px)}
  </style></head><body><div class="row">
  <div class="phone"><img src="${dataUrl('mobile-emails.png')}"></div>
  <div class="phone"><img src="${dataUrl('mobile-overview.png')}"></div>
  <div class="phone"><img src="${dataUrl('mobile-domains.png')}"></div>
  </div></body></html>`,
  1400,
  760,
  'mobile.png',
);
webp(path.join(tmp, 'mobile.png'), path.join(out, 'mobile.webp'), 2000, 82);
await browser.close();

// 4. animated tour (2.4 s per screen)
const frames = [
  'overview',
  'emails',
  'email-detail',
  'email-preview',
  'template',
  'domains',
  'webhook',
  'members',
  'audit-log',
];
for (const f of frames)
  execFileSync('cwebp', [
    '-quiet',
    '-q',
    '80',
    '-resize',
    '1440',
    '0',
    path.join(raw, `${f}.png`),
    '-o',
    path.join(tmp, `${f}.webp`),
  ]);
execFileSync('img2webp', [
  '-loop',
  '0',
  '-lossy',
  '-q',
  '72',
  '-d',
  '2400',
  ...frames.map((f) => path.join(tmp, `${f}.webp`)),
  '-o',
  path.join(out, 'tour.webp'),
]);

rmSync(tmp, { recursive: true, force: true });
console.log('README images written to docs/readme/');
