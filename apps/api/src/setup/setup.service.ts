import { Inject, Injectable } from '@nestjs/common';
import { randomToken, sha256Hex, writeAudit } from '@opensend/core';
import {
  bootstrapTokens,
  count,
  eq,
  memberships,
  organizations,
  sql,
  systemState,
  user,
  type Database,
} from '@opensend/db';
import { z } from 'zod';
import { type Auth, createCredentialUser } from '../auth/auth';
import { ApiError } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { AUTH, DB } from '../infra/tokens';
import { slugify } from '../orgs/slug';

const setupSchema = z.object({
  token: z.string().min(20).max(200),
  organizationName: z.string().trim().min(2).max(100),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(320),
  password: z.string().min(12).max(256),
});

/**
 * One-time bootstrap of the first owner. Requires a short-lived token that only someone
 * with shell access to the installation can create (`pnpm bootstrap:token`). After the
 * first user exists, setup is permanently closed.
 */
@Injectable()
export class SetupService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async needsSetup(): Promise<boolean> {
    const [row] = await this.db.select({ n: count() }).from(user);
    return Number(row?.n ?? 0) === 0;
  }

  /** Called by the CLI. Returns the plain token once; only its hash is stored. */
  async createBootstrapToken(ttlMinutes = 60): Promise<string> {
    if (!(await this.needsSetup()))
      throw new Error('this installation already has users; bootstrap is closed');
    const token = randomToken(32);
    await this.db.insert(bootstrapTokens).values({
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    });
    return token;
  }

  async complete(raw: unknown, ip: string | null) {
    const input = parseOrThrow(setupSchema, raw);
    // Phase 1: atomically consume the token and claim the bootstrap slot.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('opensend:bootstrap'))`);
      const [users] = await tx.select({ n: count() }).from(user);
      if (Number(users?.n ?? 0) > 0)
        throw new ApiError('conflict', 'setup has already been completed');
      const consumed = await tx.execute(sql`
        UPDATE bootstrap_tokens SET used_at = now()
         WHERE token_hash = ${sha256Hex(input.token)} AND used_at IS NULL AND expires_at > now()
         RETURNING id`);
      if (consumed.rows.length === 0)
        throw new ApiError('forbidden', 'invalid or expired setup token');
      await tx
        .insert(systemState)
        .values({ key: 'bootstrap', value: { startedAt: new Date().toISOString() } });
    });

    // Phase 2: create the owner and the first organization.
    try {
      const created = await createCredentialUser(this.auth, {
        email: input.email,
        name: input.name,
        password: input.password,
      });
      return await this.db.transaction(async (tx) => {
        await tx.update(user).set({ platformRole: 'admin' }).where(eq(user.id, created.id));
        const [org] = await tx
          .insert(organizations)
          .values({
            name: input.organizationName,
            slug: `${slugify(input.organizationName)}-${randomToken(3)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')}`,
          })
          .returning();
        await tx.insert(memberships).values({
          organizationId: org!.id,
          userId: created.id,
          role: 'owner',
          projectAccess: 'all',
        });
        await tx
          .update(systemState)
          .set({
            value: { completedAt: new Date().toISOString(), ownerUserId: created.id },
            updatedAt: new Date(),
          })
          .where(eq(systemState.key, 'bootstrap'));
        await writeAudit(tx, {
          organizationId: org!.id,
          actorType: 'user',
          actorId: created.id,
          action: 'installation.bootstrap',
          targetType: 'organization',
          targetId: org!.id,
          ipAddress: ip,
        });
        return { organizationId: org!.id, userId: created.id };
      });
    } catch (err) {
      // Re-open the bootstrap slot if no user could be created, so a new token can be used.
      if (await this.needsSetup())
        await this.db.delete(systemState).where(eq(systemState.key, 'bootstrap'));
      throw err;
    }
  }
}
