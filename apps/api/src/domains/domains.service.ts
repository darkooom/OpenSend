import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import {
  createDomainRequestSchema,
  type DnsRecord,
  type DomainResource,
} from '@opensend/contracts';
import {
  KeyRing,
  isLocalOnlyDomain,
  normalizeDomain,
  randomToken,
  redact,
  writeAudit,
} from '@opensend/core';
import { and, desc, domains, eq, providerConnections, type Database } from '@opensend/db';
import { PROVIDER_CAPABILITIES } from '@opensend/providers';
import { ApiError, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import type { DnsResolver } from '../infra/dns';
import type { ProviderFactory } from '../infra/infra.module';
import { CONFIG, DB, DNS_RESOLVER, KEYRING, PROVIDER_FACTORY } from '../infra/tokens';

type DomainRow = typeof domains.$inferSelect;
type ConnectionRow = typeof providerConnections.$inferSelect;

export interface DomainScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentKind: 'development' | 'staging' | 'production';
}

export interface DomainActor {
  type: 'user' | 'api_key';
  id: string;
  ip?: string | null;
}

export const OWNERSHIP_PREFIX = '_opensend';
export const ownershipRecordName = (domain: string) => `${OWNERSHIP_PREFIX}.${domain}`;
export const ownershipRecordValue = (token: string) => `opensend-verification=${token}`;

interface Diagnostics {
  checkedAt: string;
  spf: { status: string; records: string[]; message: string };
  dmarc: { status: string; records: string[]; message: string };
}

/**
 * Domain onboarding keeps three things apart:
 *  1. ownership proof   – a project-specific TXT token (`_opensend.<domain>`),
 *  2. provider identity – records the configured adapter reports (e.g. SES DKIM CNAMEs),
 *  3. DNS diagnostics   – SPF / DMARC hints that never propose conflicting records.
 * The same domain may be added to several projects/environments; each row must prove
 * ownership with its own token, so adding it elsewhere never takes over an existing row.
 */
@Injectable()
export class DomainsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KEYRING) private readonly keys: KeyRing,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(PROVIDER_FACTORY) private readonly providers: ProviderFactory,
  ) {}

  async list(scope: DomainScope): Promise<DomainResource[]> {
    const rows = await this.db
      .select({ domain: domains, connection: providerConnections })
      .from(domains)
      .leftJoin(providerConnections, eq(providerConnections.id, domains.providerConnectionId))
      .where(
        and(eq(domains.projectId, scope.projectId), eq(domains.environmentId, scope.environmentId)),
      )
      .orderBy(desc(domains.createdAt));
    const def = await this.defaultConnection(scope.environmentId);
    return rows.map((r) => this.toResource(r.domain, r.connection, def, scope));
  }

  async get(scope: DomainScope, id: string): Promise<DomainResource> {
    const { domain, connection } = await this.load(scope, id);
    return this.toResource(
      domain,
      connection,
      await this.defaultConnection(scope.environmentId),
      scope,
    );
  }

  async create(scope: DomainScope, raw: unknown, actor: DomainActor): Promise<DomainResource> {
    const body = parseOrThrow(createDomainRequestSchema, raw);
    const name = normalizeDomain(body.name);
    if (!name)
      throw new ApiError('validation_error', 'invalid domain name', [
        { path: 'name', message: 'must be a hostname like mail.example.com' },
      ]);
    const localOnly = isLocalOnlyDomain(name);
    if (localOnly && scope.environmentKind === 'production') {
      throw new ApiError(
        'validation_error',
        'reserved test domains (e.g. *.test, example.com) cannot be used in production environments',
      );
    }
    let connection: ConnectionRow | null = null;
    if (body.providerConnectionId) {
      connection = await this.connectionInEnv(scope, body.providerConnectionId);
      if (!connection)
        throw new ApiError('validation_error', 'provider connection not found in this environment');
    } else {
      connection = await this.defaultConnection(scope.environmentId);
    }
    const inserted = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(domains)
        .values({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          name,
          localOnly,
          ownershipToken: randomToken(24),
          providerConnectionId: connection?.id ?? null,
          providerStatus: localOnly ? 'not_required' : 'not_started',
        })
        .onConflictDoNothing()
        .returning();
      if (rows.length === 0) return null;
      await writeAudit(tx, {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'domain.create',
        targetType: 'domain',
        targetId: rows[0]!.id,
        metadata: { name, localOnly },
        ipAddress: actor.ip,
      });
      return rows[0]!;
    });
    if (!inserted)
      throw new ApiError('conflict', `"${name}" is already registered in this environment`);
    return this.toResource(inserted, connection, connection, scope);
  }

  async remove(scope: DomainScope, id: string, actor: DomainActor): Promise<void> {
    const { domain } = await this.load(scope, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(domains).where(eq(domains.id, domain.id));
      await writeAudit(tx, {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'domain.delete',
        targetType: 'domain',
        targetId: domain.id,
        metadata: { name: domain.name },
        ipAddress: actor.ip,
      });
    });
  }

  /** Re-checks ownership, provider identity and DNS diagnostics. */
  async verify(scope: DomainScope, id: string): Promise<DomainResource> {
    const loaded = await this.load(scope, id);
    let { domain } = loaded;
    const connection = loaded.connection ?? (await this.defaultConnection(scope.environmentId));
    const now = new Date();
    const patch: Partial<typeof domains.$inferInsert> = { updatedAt: now };

    // 1. ownership
    if (!domain.localOnly) {
      patch.ownershipCheckedAt = now;
      try {
        const txt = await this.dns.resolveTxt(ownershipRecordName(domain.name));
        if (txt.some((v) => v.trim() === ownershipRecordValue(domain.ownershipToken))) {
          patch.ownershipVerifiedAt = domain.ownershipVerifiedAt ?? now;
          patch.ownershipMissingSince = null;
          patch.ownershipLastError = null;
        } else {
          patch.ownershipLastError = txt.length
            ? `TXT record found at ${ownershipRecordName(domain.name)} but none matches the expected value`
            : `no TXT record found at ${ownershipRecordName(domain.name)}`;
        }
      } catch (err) {
        patch.ownershipLastError = `DNS lookup failed: ${redact((err as Error).message)}`;
      }
    }

    // 2. provider identity (only after ownership is proven, so we never register foreign domains)
    const ownershipOk =
      domain.localOnly || Boolean(patch.ownershipVerifiedAt ?? domain.ownershipVerifiedAt);
    if (connection) {
      patch.providerConnectionId = connection.id;
      const caps = PROVIDER_CAPABILITIES[connection.type];
      if (domain.localOnly || connection.type === 'local') {
        patch.providerStatus = 'not_required';
        patch.providerRecords = [];
      } else if (!caps.domainVerification) {
        patch.providerStatus = 'unsupported';
        patch.providerRecords = [];
        patch.providerLastError = null;
      } else if (ownershipOk) {
        patch.providerCheckedAt = now;
        try {
          const adapter = this.providers({
            type: connection.type,
            config: connection.config,
            secrets: connection.secretCiphertext
              ? this.keys.decryptJson(
                  connection.secretCiphertext,
                  `provider_connection:${connection.id}`,
                )
              : {},
          });
          try {
            const res = await adapter.setupDomain(domain.name, { create: true });
            patch.providerStatus = res.status;
            patch.providerRecords = await this.checkRecords(res.records);
            patch.providerLastError =
              res.status === 'failed' ? (res.message ?? 'provider verification failed') : null;
          } finally {
            await adapter.close();
          }
        } catch (err) {
          patch.providerStatus = 'failed';
          patch.providerLastError = redact((err as Error).message);
        }
      }
    }

    // 3. diagnostics
    if (!domain.localOnly) {
      patch.dnsDiagnostics = await this.diagnose(domain.name, connection?.type ?? null);
      patch.dnsCheckedAt = now;
    }

    [domain] = (await this.db
      .update(domains)
      .set(patch)
      .where(eq(domains.id, domain.id))
      .returning()) as [DomainRow];
    return this.toResource(
      domain,
      connection,
      await this.defaultConnection(scope.environmentId),
      scope,
    );
  }

  private async checkRecords(records: DnsRecord[]): Promise<DnsRecord[]> {
    return Promise.all(
      records.map(async (r) => {
        try {
          const found =
            r.type === 'CNAME'
              ? await this.dns.resolveCname(r.name)
              : await this.dns.resolveTxt(r.name);
          const norm = (s: string) => s.toLowerCase().replace(/\.$/, '');
          const status =
            found.length === 0
              ? 'missing'
              : found.some((f) => norm(f) === norm(r.value))
                ? 'found'
                : 'mismatch';
          return { ...r, found, status } as DnsRecord;
        } catch {
          return { ...r, status: 'unknown', found: [] } as DnsRecord;
        }
      }),
    );
  }

  async diagnose(name: string, providerType: string | null): Promise<Diagnostics> {
    const txt = await this.dns.resolveTxt(name).catch(() => [] as string[]);
    const spf = txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
    const dmarcTxt = await this.dns.resolveTxt(`_dmarc.${name}`).catch(() => [] as string[]);
    const dmarc = dmarcTxt.filter((t) => /^v=DMARC1/i.test(t.trim()));
    const sesNote =
      providerType === 'ses'
        ? ' With SES default MAIL FROM, SPF is evaluated for amazonses.com; DMARC alignment comes from DKIM.'
        : '';
    return {
      checkedAt: new Date().toISOString(),
      spf:
        spf.length === 0
          ? {
              status: 'missing',
              records: [],
              message: `No SPF record found. If your relay requires one, publish a single SPF record.${sesNote}`,
            }
          : spf.length === 1
            ? {
                status: 'ok',
                records: spf,
                message: `One SPF record found. Add any required include to this record; never publish a second SPF record.${sesNote}`,
              }
            : {
                status: 'error',
                records: spf,
                message:
                  'Multiple SPF records found. Receivers treat this as a permanent error (RFC 7208 §4.5); merge them into one.',
              },
      dmarc:
        dmarc.length === 0
          ? {
              status: 'missing',
              records: [],
              message:
                'No DMARC record found at _dmarc. A policy (even p=none) helps receivers and gives you reports.',
            }
          : dmarc.length === 1
            ? { status: 'ok', records: dmarc, message: 'DMARC record found.' }
            : {
                status: 'error',
                records: dmarc,
                message: 'Multiple DMARC records found; receivers ignore DMARC in this case.',
              },
    };
  }

  private async load(scope: DomainScope, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('domain');
    const [row] = await this.db
      .select({ domain: domains, connection: providerConnections })
      .from(domains)
      .leftJoin(providerConnections, eq(providerConnections.id, domains.providerConnectionId))
      .where(
        and(
          eq(domains.id, id),
          eq(domains.projectId, scope.projectId),
          eq(domains.environmentId, scope.environmentId),
        ),
      )
      .limit(1);
    if (!row) throw notFound('domain');
    return row;
  }

  private async defaultConnection(environmentId: string): Promise<ConnectionRow | null> {
    const [c] = await this.db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.environmentId, environmentId),
          eq(providerConnections.isDefault, true),
        ),
      )
      .limit(1);
    return c ?? null;
  }

  private async connectionInEnv(scope: DomainScope, id: string): Promise<ConnectionRow | null> {
    const [c] = await this.db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, id),
          eq(providerConnections.projectId, scope.projectId),
          eq(providerConnections.environmentId, scope.environmentId),
        ),
      )
      .limit(1);
    return c ?? null;
  }

  toResource(
    row: DomainRow,
    connection: ConnectionRow | null,
    defaultConn: ConnectionRow | null,
    scope: DomainScope,
  ): DomainResource {
    const ownershipRecord: DnsRecord = {
      purpose: 'ownership',
      type: 'TXT',
      name: ownershipRecordName(row.name),
      value: ownershipRecordValue(row.ownershipToken),
      required: !row.localOnly,
      status: row.localOnly
        ? 'unknown'
        : row.ownershipVerifiedAt
          ? 'found'
          : row.ownershipCheckedAt
            ? 'missing'
            : 'unknown',
      found: [],
      note: row.localOnly
        ? 'Local-only test domain: no DNS needed, usable only with the local provider outside production.'
        : undefined,
    };
    const active = defaultConn;
    let canSend = false;
    if (active && active.enabled && !active.pausedAt) {
      if (row.localOnly)
        canSend =
          active.type === 'local' &&
          scope.environmentKind !== 'production' &&
          this.config.OPENSEND_LOCAL_PROVIDER_ENABLED;
      else if (row.ownershipVerifiedAt) {
        canSend = PROVIDER_CAPABILITIES[active.type].domainVerification
          ? row.providerConnectionId === active.id && row.providerStatus === 'verified'
          : !(active.type === 'local' && scope.environmentKind === 'production');
      }
    }
    return {
      id: row.id,
      object: 'domain',
      name: row.name,
      localOnly: row.localOnly,
      ownership: {
        status: row.localOnly || row.ownershipVerifiedAt ? 'verified' : 'pending',
        record: ownershipRecord,
        checkedAt: row.ownershipCheckedAt?.toISOString() ?? null,
        lastError: row.ownershipLastError,
        missingSince: row.ownershipMissingSince?.toISOString() ?? null,
      },
      provider: {
        connectionId: row.providerConnectionId,
        type: connection?.type ?? null,
        status: row.providerStatus,
        records: (row.providerRecords as DnsRecord[]) ?? [],
        checkedAt: row.providerCheckedAt?.toISOString() ?? null,
        lastError: row.providerLastError,
      },
      diagnostics: (row.dnsDiagnostics as Diagnostics | null) ?? null,
      canSend,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
