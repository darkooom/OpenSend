import { Inject, Injectable } from '@nestjs/common';
import { PENDING_STATUSES } from '@opensend/contracts';
import { writeAudit } from '@opensend/core';
import {
  and,
  auditLogs,
  desc,
  domains,
  emailEvents,
  emailRecipients,
  emails,
  environments,
  eq,
  inArray,
  isNull,
  lt,
  or,
  projects,
  sql,
  webhookDeliveries,
  type Database,
} from '@opensend/db';
import type { Response } from 'express';
import { z } from 'zod';
import {
  AccessService,
  type EnvironmentAccess,
  type OrgAccess,
  type ProjectAccess,
} from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { ApiError } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { DB } from '../infra/tokens';
import { OrgsService } from '../orgs/orgs.service';
import { UsageService } from '../usage/usage.service';

const retentionSchema = z.object({
  contentDays: z.number().int().min(0).max(3650),
  attachmentDays: z.number().int().min(0).max(3650),
  eventDays: z.number().int().min(1).max(3650),
});
const envSchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(['development', 'staging', 'production']),
});

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly orgs: OrgsService,
    private readonly usage: UsageService,
  ) {}

  async get(a: ProjectAccess) {
    const envs = await this.db
      .select()
      .from(environments)
      .where(eq(environments.projectId, a.project.id))
      .orderBy(environments.createdAt);
    return {
      ...this.orgs.projectView(a.project),
      role: a.role,
      environments: envs.map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  async rename(a: ProjectAccess, u: SessionUser, raw: unknown) {
    const { name } = parseOrThrow(z.object({ name: z.string().trim().min(1).max(100) }), raw);
    await this.db
      .update(projects)
      .set({ name, updatedAt: new Date() })
      .where(eq(projects.id, a.project.id));
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'project.rename',
      targetType: 'project',
      targetId: a.project.id,
    });
    return { ok: true };
  }

  async setRetention(a: ProjectAccess, u: SessionUser, raw: unknown) {
    const input = parseOrThrow(retentionSchema, raw);
    await this.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({
          contentRetentionDays: input.contentDays,
          attachmentRetentionDays: input.attachmentDays,
          eventRetentionDays: input.eventDays,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, a.project.id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'project.retention_update',
        targetType: 'project',
        targetId: a.project.id,
        metadata: {
          before: {
            contentDays: a.project.contentRetentionDays,
            attachmentDays: a.project.attachmentRetentionDays,
            eventDays: a.project.eventRetentionDays,
          },
          after: input,
        },
      });
    });
    return input;
  }

  async createEnvironment(a: ProjectAccess, u: SessionUser, raw: unknown) {
    const input = parseOrThrow(envSchema, raw);
    const rows = await this.db
      .insert(environments)
      .values({ projectId: a.project.id, name: input.name, kind: input.kind })
      .onConflictDoNothing()
      .returning();
    if (!rows.length) throw new ApiError('conflict', `environment "${input.name}" already exists`);
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'environment.create',
      targetType: 'environment',
      targetId: rows[0]!.id,
      metadata: input,
    });
    return rows[0];
  }

  /** Dashboard overview for one environment, computed from real data only. */
  async overview(a: EnvironmentAccess) {
    const env = a.environment.id;
    const pending = sql.join(
      PENDING_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    const [stats] = (
      await this.db.execute<Record<string, number | string | null>>(sql`
        SELECT
          count(*) FILTER (WHERE accepted_at > now() - interval '24 hours')::int AS accepted_24h,
          count(*) FILTER (WHERE status = 'submitted' AND submitted_at > now() - interval '24 hours')::int AS submitted_24h,
          count(*) FILTER (WHERE status = 'failed' AND finalized_at > now() - interval '24 hours')::int AS failed_24h,
          count(*) FILTER (WHERE status = 'submission_unknown')::int AS unknown_open,
          count(*) FILTER (WHERE status IN (${pending}))::int AS pending,
          count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
          min(accepted_at) FILTER (WHERE status IN ('queued', 'retry_wait'))::text AS oldest_pending
        FROM emails WHERE project_id = ${a.project.id} AND environment_id = ${env}`)
    ).rows as [Record<string, number | string | null>];
    const [rec] = (
      await this.db.execute<Record<string, number>>(sql`
        SELECT
          count(*) FILTER (WHERE delivered_at > now() - interval '24 hours')::int AS delivered_24h,
          count(*) FILTER (WHERE bounced_at > now() - interval '24 hours')::int AS bounced_24h,
          count(*) FILTER (WHERE complained_at > now() - interval '24 hours')::int AS complained_24h
        FROM email_recipients WHERE project_id = ${a.project.id} AND environment_id = ${env}`)
    ).rows as [Record<string, number>];
    const [hooks] = (
      await this.db.execute<Record<string, number>>(sql`
        SELECT count(*) FILTER (WHERE d.status = 'dead')::int AS dead,
               count(*) FILTER (WHERE d.status IN ('pending', 'retry_wait'))::int AS backlog
        FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE e.project_id = ${a.project.id} AND e.environment_id = ${env}`)
    ).rows as [Record<string, number>];
    const domainRows = await this.db
      .select()
      .from(domains)
      .where(and(eq(domains.projectId, a.project.id), eq(domains.environmentId, env)));
    const daily = await this.db.execute<{ day: string; accepted: number; failed: number }>(sql`
      SELECT to_char(date_trunc('day', accepted_at), 'YYYY-MM-DD') AS day,
             count(*)::int AS accepted,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM emails
       WHERE project_id = ${a.project.id} AND environment_id = ${env} AND accepted_at > now() - interval '14 days'
       GROUP BY 1 ORDER BY 1`);

    const warnings: Array<{ level: 'warning' | 'error'; message: string }> = [];
    if (a.project.pausedAt)
      warnings.push({
        level: 'error',
        message: `Sending is paused by the platform operator${a.project.pausedReason ? `: ${a.project.pausedReason}` : ''}`,
      });
    if (Number(stats.unknown_open) > 0)
      warnings.push({
        level: 'warning',
        message: `${stats.unknown_open} email(s) have an unclear submission outcome and need review`,
      });
    if (Number(hooks.dead) > 0)
      warnings.push({
        level: 'warning',
        message: `${hooks.dead} webhook deliveries failed permanently`,
      });
    if (domainRows.length === 0)
      warnings.push({
        level: 'warning',
        message: 'No sender domain configured in this environment',
      });
    for (const d of domainRows) {
      if (!d.localOnly && !d.ownershipVerifiedAt)
        warnings.push({ level: 'warning', message: `Domain ${d.name}: ownership not verified` });
      if (d.providerStatus === 'failed')
        warnings.push({
          level: 'error',
          message: `Domain ${d.name}: provider verification failed`,
        });
    }

    return {
      last24h: {
        accepted: Number(stats.accepted_24h),
        submitted: Number(stats.submitted_24h),
        failed: Number(stats.failed_24h),
        delivered: Number(rec.delivered_24h),
        bounced: Number(rec.bounced_24h),
        complained: Number(rec.complained_24h),
      },
      pending: Number(stats.pending),
      scheduled: Number(stats.scheduled),
      submissionUnknown: Number(stats.unknown_open),
      oldestPendingAt: stats.oldest_pending,
      webhooks: { dead: Number(hooks.dead), backlog: Number(hooks.backlog) },
      daily: daily.rows,
      usage: await this.usage.get(a.project.id, env),
      warnings,
    };
  }

  /** Audit log of an organization, limited to org-level entries and projects the member can see. */
  async audit(access: OrgAccess, opts: { projectId?: string; before?: string }) {
    const visible = (await this.access.visibleProjects(access)).map((p) => p.id);
    const conds = [eq(auditLogs.organizationId, access.organizationId)];
    if (opts.projectId) {
      if (!visible.includes(opts.projectId)) return [];
      conds.push(eq(auditLogs.projectId, opts.projectId));
    } else {
      conds.push(
        visible.length
          ? or(isNull(auditLogs.projectId), inArray(auditLogs.projectId, visible))!
          : isNull(auditLogs.projectId),
      );
    }
    if (opts.before && !Number.isNaN(Date.parse(opts.before)))
      conds.push(lt(auditLogs.createdAt, new Date(opts.before)));
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Streams an NDJSON export of email metadata, recipients and events of ONE environment.
   * Message content is not included (it follows the content retention policy).
   */
  async export(a: EnvironmentAccess, u: SessionUser, res: Response) {
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'export.run',
      targetType: 'environment',
      targetId: a.environment.id,
    });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="opensend-${a.project.slug}-${a.environment.name}-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    const write = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    write({
      type: 'export',
      version: 1,
      projectId: a.project.id,
      environmentId: a.environment.id,
      exportedAt: new Date().toISOString(),
    });
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const page: Array<typeof emails.$inferSelect> = await this.db
        .select()
        .from(emails)
        .where(
          and(
            eq(emails.projectId, a.project.id),
            eq(emails.environmentId, a.environment.id),
            cursor
              ? or(
                  lt(emails.acceptedAt, cursor.at),
                  and(eq(emails.acceptedAt, cursor.at), lt(emails.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(emails.acceptedAt), desc(emails.id))
        .limit(200);
      if (page.length === 0) break;
      const ids = page.map((e) => e.id);
      const [recs, evs] = await Promise.all([
        this.db.select().from(emailRecipients).where(inArray(emailRecipients.emailId, ids)),
        this.db.select().from(emailEvents).where(inArray(emailEvents.emailId, ids)),
      ]);
      for (const e of page) {
        write({
          type: 'email',
          id: e.id,
          status: e.status,
          from: e.fromAddress,
          subject: e.subject,
          tags: e.tags,
          acceptedAt: e.acceptedAt,
          submittedAt: e.submittedAt,
          scheduledAt: e.scheduledAt,
          attempts: e.attemptCount,
          failureCategory: e.failureCategory,
          recipients: recs
            .filter((r) => r.emailId === e.id)
            .map((r) => ({
              address: r.address,
              kind: r.kind,
              status: r.status,
              deliveredAt: r.deliveredAt,
              bouncedAt: r.bouncedAt,
              complainedAt: r.complainedAt,
            })),
          events: evs
            .filter((x) => x.emailId === e.id)
            .map((x) => ({
              type: x.type,
              source: x.source,
              occurredAt: x.occurredAt,
              data: x.data,
            })),
        });
      }
      const last = page[page.length - 1]!;
      cursor = { at: last.acceptedAt, id: last.id };
      if (page.length < 200) break;
    }
    res.end();
  }

  /** Webhook dead letters across all endpoints of the environment. */
  async deadLetters(a: EnvironmentAccess) {
    const rows = await this.db.execute<Record<string, unknown>>(sql`
      SELECT d.id, d.status, d.attempt_count, d.last_status_code, d.last_error, d.created_at, ev.type AS event_type, ev.id AS event_id, e.url
        FROM webhook_deliveries d
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
        JOIN webhook_events ev ON ev.id = d.webhook_event_id
       WHERE e.project_id = ${a.project.id} AND e.environment_id = ${a.environment.id} AND d.status = 'dead'
       ORDER BY d.created_at DESC LIMIT 100`);
    void webhookDeliveries;
    return rows.rows;
  }
}
