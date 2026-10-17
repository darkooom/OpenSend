import { Inject, Injectable } from '@nestjs/common';
import { addSuppression, writeAudit } from '@opensend/core';
import { and, desc, eq, ilike, suppressions, type Database } from '@opensend/db';
import { z } from 'zod';
import type { EnvironmentAccess } from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { DB } from '../infra/tokens';

/** Tenant suppression list (per environment). Platform-wide blocks are a separate concept. */
@Injectable()
export class SuppressionsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(a: EnvironmentAccess, q?: string) {
    const conds = [
      eq(suppressions.projectId, a.project.id),
      eq(suppressions.environmentId, a.environment.id),
    ];
    if (q) conds.push(ilike(suppressions.address, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
    const rows = await this.db
      .select()
      .from(suppressions)
      .where(and(...conds))
      .orderBy(desc(suppressions.createdAt))
      .limit(200);
    return rows.map((s) => ({
      id: s.id,
      address: s.address,
      reason: s.reason,
      note: s.note,
      sourceEmailId: s.sourceEmailId,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  async add(a: EnvironmentAccess, u: SessionUser, raw: unknown) {
    const input = parseOrThrow(
      z.object({ address: z.email().max(320), note: z.string().max(200).optional() }),
      raw,
    );
    await addSuppression(this.db, {
      projectId: a.project.id,
      environmentId: a.environment.id,
      address: input.address,
      reason: 'manual',
      note: input.note,
    });
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'suppression.add',
      targetType: 'suppression',
      metadata: { reason: 'manual' },
    });
    return { ok: true };
  }

  async remove(a: EnvironmentAccess, u: SessionUser, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('suppression');
    const rows = await this.db
      .delete(suppressions)
      .where(
        and(
          eq(suppressions.id, id),
          eq(suppressions.projectId, a.project.id),
          eq(suppressions.environmentId, a.environment.id),
        ),
      )
      .returning({ id: suppressions.id });
    if (!rows.length) throw notFound('suppression');
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'suppression.remove',
      targetType: 'suppression',
      targetId: id,
    });
  }
}
