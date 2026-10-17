import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { writeAudit } from '@opensend/core';
import {
  desc,
  eq,
  organizations,
  platformSuppressions,
  projects,
  providerConnections,
  type Database,
} from '@opensend/db';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { ClientIp, CurrentUser, SessionGuard, type SessionUser } from '../auth/guards';
import { notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { DB } from '../infra/tokens';

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * Platform operator controls. Operators can pause projects and connections and manage the
 * instance-wide block list; they do NOT get read access to tenant email data through these routes.
 */
@Controller('api/admin')
@UseGuards(SessionGuard)
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  @Get('projects')
  async projects(@CurrentUser() u: SessionUser) {
    this.access.requirePlatformAdmin(u);
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        organization: organizations.name,
        pausedAt: projects.pausedAt,
        pausedReason: projects.pausedReason,
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .orderBy(organizations.name, projects.name);
    return rows;
  }

  private async setProjectPause(
    u: SessionUser,
    id: string,
    paused: boolean,
    reason: string | null,
    ip: string | null,
  ) {
    this.access.requirePlatformAdmin(u);
    const [p] = await this.db
      .update(projects)
      .set({ pausedAt: paused ? new Date() : null, pausedReason: reason, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (!p) throw notFound('project');
    await writeAudit(this.db, {
      organizationId: p.organizationId,
      projectId: p.id,
      actorType: 'platform_admin',
      actorId: u.id,
      action: paused ? 'project.pause' : 'project.resume',
      targetType: 'project',
      targetId: p.id,
      metadata: { reason },
      ipAddress: ip,
    });
    return { id: p.id, pausedAt: p.pausedAt?.toISOString() ?? null, pausedReason: p.pausedReason };
  }

  @Post('projects/:id/pause')
  @HttpCode(200)
  pause(
    @CurrentUser() u: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.setProjectPause(u, id, true, parseOrThrow(reasonSchema, body).reason, ip);
  }

  @Post('projects/:id/resume')
  @HttpCode(200)
  resume(@CurrentUser() u: SessionUser, @Param('id') id: string, @ClientIp() ip: string | null) {
    return this.setProjectPause(u, id, false, null, ip);
  }

  @Post('connections/:id/pause')
  @HttpCode(200)
  async pauseConnection(
    @CurrentUser() u: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    this.access.requirePlatformAdmin(u);
    const { reason } = parseOrThrow(reasonSchema, body);
    const [c] = await this.db
      .update(providerConnections)
      .set({ pausedAt: new Date(), pausedReason: reason })
      .where(eq(providerConnections.id, id))
      .returning();
    if (!c) throw notFound('connection');
    await writeAudit(this.db, {
      projectId: c.projectId,
      actorType: 'platform_admin',
      actorId: u.id,
      action: 'provider_connection.pause',
      targetType: 'provider_connection',
      targetId: c.id,
      metadata: { reason },
      ipAddress: ip,
    });
    return { id: c.id, pausedAt: c.pausedAt?.toISOString() };
  }

  @Post('connections/:id/resume')
  @HttpCode(200)
  async resumeConnection(
    @CurrentUser() u: SessionUser,
    @Param('id') id: string,
    @ClientIp() ip: string | null,
  ) {
    this.access.requirePlatformAdmin(u);
    const [c] = await this.db
      .update(providerConnections)
      .set({ pausedAt: null, pausedReason: null })
      .where(eq(providerConnections.id, id))
      .returning();
    if (!c) throw notFound('connection');
    await writeAudit(this.db, {
      projectId: c.projectId,
      actorType: 'platform_admin',
      actorId: u.id,
      action: 'provider_connection.resume',
      targetType: 'provider_connection',
      targetId: c.id,
      ipAddress: ip,
    });
    return { id: c.id, pausedAt: null };
  }

  @Get('suppressions')
  async platformSuppressions(@CurrentUser() u: SessionUser) {
    this.access.requirePlatformAdmin(u);
    return this.db
      .select()
      .from(platformSuppressions)
      .orderBy(desc(platformSuppressions.createdAt))
      .limit(500);
  }

  @Post('suppressions')
  async addPlatformSuppression(
    @CurrentUser() u: SessionUser,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    this.access.requirePlatformAdmin(u);
    const input = parseOrThrow(
      z.object({ address: z.email().max(320), reason: z.string().trim().min(3).max(200) }),
      body,
    );
    await this.db
      .insert(platformSuppressions)
      .values({ address: input.address.toLowerCase(), reason: input.reason, createdByUserId: u.id })
      .onConflictDoNothing();
    await writeAudit(this.db, {
      actorType: 'platform_admin',
      actorId: u.id,
      action: 'platform_suppression.add',
      targetType: 'platform_suppression',
      metadata: { reason: input.reason },
      ipAddress: ip,
    });
    return { ok: true };
  }

  @Delete('suppressions/:id')
  @HttpCode(204)
  async removePlatformSuppression(
    @CurrentUser() u: SessionUser,
    @Param('id') id: string,
    @ClientIp() ip: string | null,
  ) {
    this.access.requirePlatformAdmin(u);
    await this.db.delete(platformSuppressions).where(eq(platformSuppressions.id, id));
    await writeAudit(this.db, {
      actorType: 'platform_admin',
      actorId: u.id,
      action: 'platform_suppression.remove',
      targetType: 'platform_suppression',
      targetId: id,
      ipAddress: ip,
    });
  }
}
