import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import { KeyRing, assertHostnameShape, redact, writeAudit } from '@opensend/core';
import { and, desc, eq, ne, providerConnections, type Database } from '@opensend/db';
import { PROVIDER_CAPABILITIES, validateConnection } from '@opensend/providers';
import { z, ZodError } from 'zod';
import type { EnvironmentAccess } from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { ApiError, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import type { ProviderFactory } from '../infra/infra.module';
import { CONFIG, DB, KEYRING, PROVIDER_FACTORY } from '../infra/tokens';

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['local', 'smtp', 'ses']),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().default(true),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
});

type ConnectionRow = typeof providerConnections.$inferSelect;

/** Tenant-managed provider connections. Credentials are encrypted and never returned. */
@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KEYRING) private readonly keys: KeyRing,
    @Inject(PROVIDER_FACTORY) private readonly providers: ProviderFactory,
  ) {}

  view(c: ConnectionRow) {
    const cfg = c.config as Record<string, unknown>;
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      config: cfg,
      hasSecrets: Boolean(c.secretCiphertext),
      isDefault: c.isDefault,
      enabled: c.enabled,
      paused: c.pausedAt ? { at: c.pausedAt.toISOString(), reason: c.pausedReason } : null,
      capabilities: PROVIDER_CAPABILITIES[c.type],
      eventsEndpoint:
        c.type === 'ses'
          ? `${this.config.PUBLIC_API_URL.replace(/\/$/, '')}/webhooks/ses/${c.id}`
          : null,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async list(a: EnvironmentAccess) {
    const rows = await this.db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.projectId, a.project.id),
          eq(providerConnections.environmentId, a.environment.id),
        ),
      )
      .orderBy(desc(providerConnections.createdAt));
    return {
      localProviderAvailable:
        this.config.OPENSEND_LOCAL_PROVIDER_ENABLED && a.environment.kind !== 'production',
      data: rows.map((r) => this.view(r)),
    };
  }

  private validate(
    a: EnvironmentAccess,
    type: 'local' | 'smtp' | 'ses',
    config: unknown,
    secrets: unknown,
  ) {
    if (type === 'local') {
      if (!this.config.OPENSEND_LOCAL_PROVIDER_ENABLED)
        throw new ApiError(
          'validation_error',
          'the local development provider is disabled on this instance',
        );
      if (a.environment.kind === 'production')
        throw new ApiError(
          'validation_error',
          'the local provider cannot be used in a production environment',
        );
    }
    let v;
    try {
      v = validateConnection(type, config, secrets);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ApiError(
          'validation_error',
          'invalid provider configuration',
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      throw err;
    }
    if (type === 'smtp') {
      try {
        assertHostnameShape((v.config as { host: string }).host, {
          privateHostAllowlist: this.config.OPENSEND_PRIVATE_NETWORK_ALLOWLIST,
        });
      } catch (err) {
        throw new ApiError('validation_error', (err as Error).message);
      }
    }
    return v;
  }

  async create(a: EnvironmentAccess, u: SessionUser, raw: unknown, ip: string | null) {
    const input = parseOrThrow(createSchema, raw);
    const v = this.validate(a, input.type, input.config, input.secrets);
    const row = await this.db.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(providerConnections)
          .set({ isDefault: false })
          .where(eq(providerConnections.environmentId, a.environment.id));
      }
      const [c] = await tx
        .insert(providerConnections)
        .values({
          projectId: a.project.id,
          environmentId: a.environment.id,
          name: input.name,
          type: input.type,
          config: v.config,
          isDefault: input.isDefault,
        })
        .returning();
      const hasSecrets = Object.keys(v.secrets).length > 0;
      if (hasSecrets) {
        await tx
          .update(providerConnections)
          .set({
            secretCiphertext: this.keys.encryptJson(v.secrets, `provider_connection:${c!.id}`),
          })
          .where(eq(providerConnections.id, c!.id));
      }
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'provider_connection.create',
        targetType: 'provider_connection',
        targetId: c!.id,
        metadata: { type: input.type, name: input.name },
        ipAddress: ip,
      });
      return { ...c!, secretCiphertext: hasSecrets ? 'x' : null };
    });
    return this.view(row);
  }

  private async load(a: EnvironmentAccess, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('provider connection');
    const [c] = await this.db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, id),
          eq(providerConnections.projectId, a.project.id),
          eq(providerConnections.environmentId, a.environment.id),
        ),
      )
      .limit(1);
    if (!c) throw notFound('provider connection');
    return c;
  }

  async update(a: EnvironmentAccess, u: SessionUser, id: string, raw: unknown, ip: string | null) {
    const input = parseOrThrow(updateSchema, raw);
    const current = await this.load(a, id);
    const currentSecrets = current.secretCiphertext
      ? this.keys.decryptJson<Record<string, unknown>>(
          current.secretCiphertext,
          `provider_connection:${id}`,
        )
      : {};
    const v =
      input.config || input.secrets
        ? this.validate(
            a,
            current.type,
            input.config ?? current.config,
            input.secrets ? { ...currentSecrets, ...input.secrets } : currentSecrets,
          )
        : null;
    const row = await this.db.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(providerConnections)
          .set({ isDefault: false })
          .where(
            and(
              eq(providerConnections.environmentId, a.environment.id),
              ne(providerConnections.id, id),
            ),
          );
      }
      const [c] = await tx
        .update(providerConnections)
        .set({
          name: input.name ?? current.name,
          enabled: input.enabled ?? current.enabled,
          isDefault: input.isDefault ?? current.isDefault,
          config: v?.config ?? current.config,
          secretCiphertext:
            v && Object.keys(v.secrets).length
              ? this.keys.encryptJson(v.secrets, `provider_connection:${id}`)
              : current.secretCiphertext,
          updatedAt: new Date(),
        })
        .where(eq(providerConnections.id, id))
        .returning();
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'provider_connection.update',
        targetType: 'provider_connection',
        targetId: id,
        metadata: {
          fields: Object.keys(input).filter((k) => k !== 'secrets'),
          secretsChanged: Boolean(input.secrets),
        },
        ipAddress: ip,
      });
      return c!;
    });
    return this.view(row);
  }

  async remove(a: EnvironmentAccess, u: SessionUser, id: string, ip: string | null) {
    await this.load(a, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(providerConnections).where(eq(providerConnections.id, id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'provider_connection.delete',
        targetType: 'provider_connection',
        targetId: id,
        ipAddress: ip,
      });
    });
  }

  /** "Test connection": a cheap credential/connectivity check, never sends an email. */
  async test(a: EnvironmentAccess, id: string) {
    const c = await this.load(a, id);
    try {
      const adapter = this.providers({
        type: c.type,
        config: c.config,
        secrets: c.secretCiphertext
          ? this.keys.decryptJson(c.secretCiphertext, `provider_connection:${c.id}`)
          : {},
      });
      try {
        return await adapter.verify();
      } finally {
        await adapter.close();
      }
    } catch (err) {
      return { ok: false, message: redact((err as Error).message) ?? 'connection test failed' };
    }
  }
}
