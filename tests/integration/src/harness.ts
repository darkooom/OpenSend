import { randomBytes } from 'node:crypto';
import { createApp, setSnsCertFetcher } from '@opensend/api';
import { parseConfig, type AppConfig } from '@opensend/config';
import { KeyRing, MemoryObjectStore, createLogger } from '@opensend/core';
import { createDb, sql, type DbHandle } from '@opensend/db';
import {
  createProviderAdapter,
  type ConnectionSpec,
  type OutgoingMessage,
  type ProviderAdapter,
  type StatusLookupResult,
  type SubmitResult,
} from '@opensend/providers';
import {
  dispatchOutbox,
  processProviderEvent,
  processSendEmail,
  processWebhookDelivery,
  type JobKind,
  type JobPayload,
  type WorkerDeps,
} from '@opensend/worker';
import request from 'supertest';
import { IT } from './env';

export const WEB_ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery-staple';

/** Programmable provider test double. Records every hand-off. */
export class FakeProvider {
  readonly submitted: OutgoingMessage[] = [];
  private queue: Array<SubmitResult | ((m: OutgoingMessage) => SubmitResult)> = [];
  lookup: StatusLookupResult = { status: 'unsupported' };
  domainSetup: Awaited<ReturnType<ProviderAdapter['setupDomain']>> = {
    status: 'verified',
    records: [],
  };

  next(...results: Array<SubmitResult | ((m: OutgoingMessage) => SubmitResult)>) {
    this.queue.push(...results);
  }

  adapter(spec: ConnectionSpec): ProviderAdapter {
    const caps = {
      local: { send: true, domainVerification: false, deliveryEvents: false, statusLookup: true },
      smtp: { send: true, domainVerification: false, deliveryEvents: false, statusLookup: false },
      ses: { send: true, domainVerification: true, deliveryEvents: true, statusLookup: false },
    }[spec.type];
    return {
      type: spec.type,
      capabilities: caps,
      submit: async (m) => {
        this.submitted.push(m);
        const r = this.queue.shift();
        const result = typeof r === 'function' ? r(m) : r;
        return (
          result ?? {
            outcome: 'accepted',
            providerMessageId: `fake-${this.submitted.length}-${randomBytes(4).toString('hex')}`,
            acceptedRecipients: [...m.to, ...m.cc, ...m.bcc],
            rejectedRecipients: [],
          }
        );
      },
      lookupStatus: async () => this.lookup,
      setupDomain: async () => this.domainSetup,
      verify: async () => ({ ok: true, message: 'fake ok' }),
      close: async () => {},
    };
  }
}

/** DNS test double keyed by record name. */
export class FakeDns {
  txt = new Map<string, string[]>();
  cname = new Map<string, string[]>();
  async resolveTxt(name: string) {
    return this.txt.get(name) ?? [];
  }
  async resolveCname(name: string) {
    return this.cname.get(name) ?? [];
  }
}

export interface Harness {
  config: AppConfig;
  http: ReturnType<typeof request>;
  server: Parameters<typeof request>[0];
  db: DbHandle['db'];
  store: MemoryObjectStore;
  dns: FakeDns;
  provider: FakeProvider;
  deps: WorkerDeps;
  enqueued: Array<{ kind: JobKind; payload: JobPayload; jobId: string }>;
  close(): Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: IT.databaseUrl,
    REDIS_URL: IT.redisUrl,
    PUBLIC_WEB_URL: WEB_ORIGIN,
    PUBLIC_API_URL: 'http://localhost:3001',
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    OPENSEND_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    OPENSEND_ENCRYPTION_ACTIVE_KEY_ID: 'v1',
    S3_BUCKET: 'unused-in-tests',
    S3_ACCESS_KEY_ID: 'unused',
    S3_SECRET_ACCESS_KEY: 'unused-secret',
    OPENSEND_LOCAL_PROVIDER_ENABLED: 'true',
    MAILPIT_SMTP_HOST: IT.mailpitSmtpHost,
    MAILPIT_SMTP_PORT: String(IT.mailpitSmtpPort),
    MAILPIT_API_URL: IT.mailpitApiUrl,
    OPENSEND_WEBHOOK_ALLOW_HTTP: 'true',
    OPENSEND_PRIVATE_NETWORK_ALLOWLIST: '',
    OPENSEND_RATE_LIMIT_PER_MINUTE: '100000',
    OPENSEND_RATE_LIMIT_PER_PROJECT_PER_MINUTE: '100000',
    ...overrides,
  });
}

/** Starts the real API (in-process) against the integration database. */
export async function startHarness(
  opts: { config?: Record<string, string>; realProviders?: boolean } = {},
): Promise<Harness> {
  const config = testConfig(opts.config);
  const store = new MemoryObjectStore();
  const dns = new FakeDns();
  const provider = new FakeProvider();
  const realFactory = (spec: ConnectionSpec) =>
    createProviderAdapter(spec, {
      timeoutMs: 10_000,
      policy: { privateHostAllowlist: config.OPENSEND_PRIVATE_NETWORK_ALLOWLIST },
      localEnabled: true,
      mailpit: {
        smtpHost: config.MAILPIT_SMTP_HOST,
        smtpPort: config.MAILPIT_SMTP_PORT,
        apiUrl: config.MAILPIT_API_URL,
      },
    });
  const factory = opts.realProviders
    ? realFactory
    : (spec: ConnectionSpec) => provider.adapter(spec);
  const app = await createApp({
    config,
    objectStore: store,
    dnsResolver: dns,
    providerFactory: factory,
  });
  const server = app.getHttpServer();
  const handle = createDb(config.DATABASE_URL, { max: 10 });
  const enqueued: Harness['enqueued'] = [];
  const deps: WorkerDeps = {
    db: handle.db,
    config,
    keys: KeyRing.fromEnv(
      config.OPENSEND_ENCRYPTION_KEYS,
      config.OPENSEND_ENCRYPTION_ACTIVE_KEY_ID,
    ),
    store,
    providers: factory,
    logger: createLogger({ name: 'test-worker', level: 'silent' }),
    workerId: `test-worker-${randomBytes(3).toString('hex')}`,
  };
  return {
    config,
    http: request(server),
    server,
    db: handle.db,
    store,
    dns,
    provider,
    deps,
    enqueued,
    async close() {
      setSnsCertFetcher(null);
      await app.close();
      await handle.close();
    },
  };
}

export async function resetDatabase(h: Harness): Promise<void> {
  const tables = await h.db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const list = tables.rows.map((t) => `"${t.tablename}"`).join(', ');
  await h.db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
  h.store.objects.clear();
  h.provider.submitted.length = 0;
  h.enqueued.length = 0;
}

/** A signed-in browser-like client (cookie jar + Origin header for CSRF checks). */
export class Client {
  constructor(readonly agent: ReturnType<typeof request.agent>) {}
  get(path: string) {
    return this.agent.get(path).set('origin', WEB_ORIGIN);
  }
  post(path: string, body?: unknown) {
    return this.agent
      .post(path)
      .set('origin', WEB_ORIGIN)
      .send(body as object);
  }
  patch(path: string, body?: unknown) {
    return this.agent
      .patch(path)
      .set('origin', WEB_ORIGIN)
      .send(body as object);
  }
  delete(path: string) {
    return this.agent.delete(path).set('origin', WEB_ORIGIN);
  }
}

export async function signIn(h: Harness, email: string, password = PASSWORD): Promise<Client> {
  const agent = request.agent(h.server);
  const res = await agent
    .post('/api/auth/sign-in/email')
    .set('origin', WEB_ORIGIN)
    .send({ email, password });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${res.text}`);
  return new Client(agent);
}

export interface Tenant {
  owner: Client;
  orgId: string;
  projectId: string;
  envId: string;
  apiKey: string;
}

let ownerCounter = 0;
/** Bootstraps the installation (first call) or creates a new org via the platform admin. */
export async function createTenant(
  h: Harness,
  opts: {
    domain?: string;
    envKind?: 'development' | 'staging' | 'production';
    scopes?: string[];
  } = {},
): Promise<Tenant> {
  const res = await h.http.get('/api/setup/status');
  let owner: Client;
  let orgId: string;
  if (res.body.needsSetup) {
    const token = await createBootstrapToken(h);
    const email = `owner${++ownerCounter}@agency.test`;
    const s = await h.http
      .post('/api/setup')
      .set('origin', WEB_ORIGIN)
      .send({ token, organizationName: 'Agency', name: 'Owner', email, password: PASSWORD });
    if (s.status !== 201) throw new Error(`setup failed ${s.status} ${s.text}`);
    owner = await signIn(h, email);
    orgId = s.body.organizationId;
    adminClient = owner;
  } else {
    // Further tenants: an organization created by the platform admin, owned by a new invited user.
    const admin = adminClient!;
    const org = await admin.post('/api/orgs', { name: `Org ${++ownerCounter}` });
    orgId = org.body.id;
    const email = `owner${ownerCounter}@tenant.test`;
    const inv = await admin.post(`/api/orgs/${orgId}/invitations`, { email, role: 'owner' });
    const token = new URL(inv.body.url).searchParams.get('token');
    const acc = await h.http
      .post('/api/invitations/accept')
      .set('origin', WEB_ORIGIN)
      .send({ token, name: 'Tenant Owner', password: PASSWORD });
    if (acc.status !== 201) throw new Error(`accept failed ${acc.status} ${acc.text}`);
    owner = await signIn(h, email);
    // the platform admin leaves the tenant org so it has no access
    const members = await owner.get(`/api/orgs/${orgId}/members`);
    const adminMember = members.body.find((m: { email: string }) => m.email !== email);
    await owner.delete(`/api/orgs/${orgId}/members/${adminMember.id}`);
  }
  const p = await owner.post(`/api/orgs/${orgId}/projects`, {
    name: 'Project',
    environments: [{ name: opts.envKind ?? 'development', kind: opts.envKind ?? 'development' }],
  });
  if (p.status !== 201) throw new Error(`project failed ${p.status} ${p.text}`);
  const projectId = p.body.id;
  const envId = p.body.environments[0].id;
  const conn = await owner.post(`/api/projects/${projectId}/environments/${envId}/providers`, {
    name: 'Local',
    type: opts.envKind === 'production' ? 'ses' : 'local',
    ...(opts.envKind === 'production'
      ? {
          config: { region: 'eu-central-1', snsTopicArns: [] },
          secrets: {
            accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
            secretAccessKey: 'fake-secret-access-key-for-tests-0000',
          },
        }
      : {}),
  });
  if (conn.status !== 201) throw new Error(`connection failed ${conn.status} ${conn.text}`);
  const domain = opts.domain ?? 'acme.test';
  const d = await owner.post(`/api/projects/${projectId}/environments/${envId}/domains`, {
    name: domain,
  });
  if (d.status !== 201) throw new Error(`domain failed ${d.status} ${d.text}`);
  const k = await owner.post(`/api/projects/${projectId}/environments/${envId}/api-keys`, {
    name: 'test',
    scopes: opts.scopes ?? [
      'emails:send',
      'emails:read',
      'domains:read',
      'domains:manage',
      'usage:read',
    ],
  });
  return { owner, orgId, projectId, envId, apiKey: k.body.key };
}

let adminClient: Client | undefined;
export function resetTenants() {
  adminClient = undefined;
  ownerCounter = 0;
}

async function createBootstrapToken(h: Harness): Promise<string> {
  const { sha256Hex, randomToken } = await import('@opensend/core');
  const token = randomToken(32);
  await h.db.execute(
    sql`INSERT INTO bootstrap_tokens (token_hash, expires_at) VALUES (${sha256Hex(token)}, now() + interval '1 hour')`,
  );
  return token;
}

export function v1(h: Harness, key: string) {
  return {
    post: (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      let r = h.http.post(path).set('authorization', `Bearer ${key}`);
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send(body as object);
    },
    get: (path: string) => h.http.get(path).set('authorization', `Bearer ${key}`),
  };
}

export function sampleEmail(over: Record<string, unknown> = {}) {
  return {
    from: 'Acme <hello@acme.test>',
    to: ['alice@example.test'],
    subject: 'Hello',
    text: 'Hi',
    html: '<p>Hi</p>',
    ...over,
  };
}

/** Run the dispatcher once and process every produced job inline (no Redis). */
export async function drain(h: Harness, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const jobs: Array<{ kind: JobKind; payload: JobPayload }> = [];
    await dispatchOutbox(h.deps, async (kind, payload, jobId) => {
      jobs.push({ kind, payload });
      h.enqueued.push({ kind, payload, jobId });
    });
    if (jobs.length === 0) return;
    for (const j of jobs) {
      if (j.kind === 'send_email')
        await processSendEmail(h.deps, j.payload.refId, j.payload.outboxId);
      else if (j.kind === 'deliver_webhook')
        await processWebhookDelivery(h.deps, j.payload.refId, j.payload.outboxId);
      else await processProviderEvent(h.deps, j.payload.refId, j.payload.outboxId);
    }
  }
}
