import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SmtpAdapter, type OutgoingMessage } from '@opensend/providers';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real STARTTLS / implicit TLS relays (smtp-server from the nodemailer project) with a
 * certificate generated for this run. Proves: certificates are verified, STARTTLS is required,
 * authentication works only over TLS, and failures are classified before DATA.
 */
const dir = mkdtempSync(path.join(tmpdir(), 'opensend-smtp-tls-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-keyout',
    path.join(dir, 'key.pem'),
    '-out',
    path.join(dir, 'cert.pem'),
  ],
  { stdio: 'ignore' },
);
const key = readFileSync(path.join(dir, 'key.pem'));
const cert = readFileSync(path.join(dir, 'cert.pem'));

const received: Array<{ to: string[]; raw: string }> = [];
function server(opts: { secure?: boolean; noStartTls?: boolean }) {
  return new SMTPServer({
    secure: opts.secure,
    disabledCommands: opts.noStartTls ? ['STARTTLS'] : [],
    key,
    cert,
    logger: false,
    authOptional: false,
    allowInsecureAuth: false,
    onAuth: (auth, _s, cb) =>
      auth.username === 'relay-user' && auth.password === 'relay-pass'
        ? cb(null, { user: 'relay-user' })
        : cb(new Error('Invalid username or password')),
    onData: (stream, session, cb) => {
      let raw = '';
      stream.on('data', (c: Buffer) => (raw += c.toString()));
      stream.on('end', () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
}
const listen = (s: SMTPServer) =>
  new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.server.address() as AddressInfo).port)),
  );

let starttls: SMTPServer;
let implicit: SMTPServer;
let plain: SMTPServer;
let ports: { starttls: number; implicit: number; plain: number };
beforeAll(async () => {
  starttls = server({});
  implicit = server({ secure: true });
  plain = server({ noStartTls: true });
  ports = {
    starttls: await listen(starttls),
    implicit: await listen(implicit),
    plain: await listen(plain),
  };
});
afterAll(() => {
  starttls.close();
  implicit.close();
  plain.close();
});

const message: OutgoingMessage = {
  messageId: '<tls-test@relay.test>',
  from: { email: 'hello@relay.test' },
  to: ['a@example.test'],
  cc: [],
  bcc: ['b@example.test'],
  replyTo: [],
  subject: 'TLS relay test',
  text: 'over TLS',
  headers: {},
  attachments: [],
  tags: {},
};
const adapter = (
  port: number,
  security: 'starttls' | 'tls',
  opts: { ca?: boolean; password?: string } = {},
) =>
  new SmtpAdapter(
    { host: 'localhost', port, security, username: 'relay-user' },
    { password: opts.password ?? 'relay-pass' },
    {
      timeoutMs: 5000,
      policy: { privateHostAllowlist: ['localhost'] },
      tlsCa: opts.ca === false ? undefined : cert.toString(),
    },
  );

describe('generic SMTP relay over TLS', () => {
  it('sends via STARTTLS with authentication and a verified certificate', async () => {
    const r = await adapter(ports.starttls, 'starttls').submit(message);
    expect(r).toMatchObject({
      outcome: 'accepted',
      acceptedRecipients: ['a@example.test', 'b@example.test'],
    });
    const last = received[received.length - 1]!;
    expect(last.to).toEqual(['a@example.test', 'b@example.test']);
    expect(last.raw).not.toMatch(/^Bcc:/im);
  });

  it('sends via implicit TLS (port 465 style)', async () => {
    expect((await adapter(ports.implicit, 'tls').submit(message)).outcome).toBe('accepted');
  });

  it('refuses an untrusted certificate before any data is sent', async () => {
    const before = received.length;
    const r = await adapter(ports.starttls, 'starttls', { ca: false }).submit(message);
    expect(r.outcome).toBe('transient_failure');
    expect(received.length).toBe(before);
    expect((await adapter(ports.starttls, 'starttls', { ca: false }).verify()).ok).toBe(false);
  });

  it('refuses a relay that does not offer STARTTLS', async () => {
    const before = received.length;
    const r = await adapter(ports.plain, 'starttls').submit(message);
    // The relay answers STARTTLS with 5xx: a configuration problem, reported as failed, nothing sent.
    expect(r.outcome).toBe('permanent_failure');
    expect(received.length).toBe(before);
  });

  it('classifies rejected credentials (535) as a permanent authentication failure', async () => {
    const before = received.length;
    const r = await adapter(ports.starttls, 'starttls', { password: 'wrong' }).submit(message);
    expect(r).toMatchObject({ outcome: 'permanent_failure', category: 'authentication' });
    expect(received.length).toBe(before);
  });

  it('connection test reports success', async () => {
    expect(await adapter(ports.starttls, 'starttls').verify()).toMatchObject({ ok: true });
  });
});
