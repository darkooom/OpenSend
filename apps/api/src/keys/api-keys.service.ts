import { Inject, Injectable } from '@nestjs/common';
import { API_KEY_SCOPES } from '@opensend/contracts';
import { generateApiKey, writeAudit } from '@opensend/core';
import { and, apiKeys, desc, eq, isNull, type Database } from '@opensend/db';
import { z } from 'zod';
import type { EnvironmentAccess } from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { ApiError, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { DB } from '../infra/tokens';

const createKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(a: EnvironmentAccess) {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.projectId, a.project.id), eq(apiKeys.environmentId, a.environment.id)))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: `os_${k.prefix}_…`,
      scopes: k.scopes,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      active: !k.revokedAt && (!k.expiresAt || k.expiresAt.getTime() > Date.now()),
    }));
  }

  /** The full key is returned exactly once; only prefix + SHA-256 of the secret are stored. */
  async create(a: EnvironmentAccess, u: SessionUser, raw: unknown, ip: string | null) {
    const input = parseOrThrow(createKeySchema, raw);
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new ApiError('validation_error', 'expiresAt must be in the future');
    const generated = generateApiKey();
    const row = await this.db.transaction(async (tx) => {
      const [k] = await tx
        .insert(apiKeys)
        .values({
          projectId: a.project.id,
          environmentId: a.environment.id,
          name: input.name,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          scopes: [...new Set(input.scopes)],
          createdByUserId: u.id,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning();
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: k!.id,
        metadata: { name: input.name, scopes: input.scopes, environmentId: a.environment.id },
        ipAddress: ip,
      });
      return k!;
    });
    return {
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      key: generated.key,
    };
  }

  async revoke(a: EnvironmentAccess, u: SessionUser, id: string, ip: string | null) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('API key');
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, id),
            eq(apiKeys.projectId, a.project.id),
            eq(apiKeys.environmentId, a.environment.id),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id });
      if (!rows.length) throw notFound('API key');
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: id,
        ipAddress: ip,
      });
    });
  }
}
