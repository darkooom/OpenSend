import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import { PENDING_STATUSES, type UsageResponse } from '@opensend/contracts';
import { usagePeriod } from '@opensend/core';
import { and, eq, projects, sql, usagePeriods, type Database } from '@opensend/db';
import { CONFIG, DB } from '../infra/tokens';

@Injectable()
export class UsageService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Usage of one project (quota is per project); `pending` is scoped to the given environment. */
  async get(projectId: string, environmentId: string | null): Promise<UsageResponse> {
    const period = usagePeriod();
    const [[project], [row], pendingRes] = await Promise.all([
      this.db
        .select({ quota: projects.monthlyRecipientQuota })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1),
      this.db
        .select()
        .from(usagePeriods)
        .where(and(eq(usagePeriods.projectId, projectId), eq(usagePeriods.period, period)))
        .limit(1),
      this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM emails
         WHERE project_id = ${projectId}
           ${environmentId ? sql`AND environment_id = ${environmentId}` : sql``}
           AND status IN (${sql.join(
             PENDING_STATUSES.map((s) => sql`${s}`),
             sql`, `,
           )})`),
    ]);
    const quota = project?.quota ?? this.config.OPENSEND_DEFAULT_MONTHLY_QUOTA;
    const used = row?.acceptedRecipients ?? 0;
    return {
      object: 'usage',
      period,
      acceptedEmails: row?.acceptedEmails ?? 0,
      acceptedRecipients: used,
      quota: { recipients: quota, remaining: Math.max(0, quota - used) },
      pending: Number(pendingRes.rows[0]?.n ?? 0),
      limits: {
        maxRecipientsPerEmail: this.config.OPENSEND_MAX_RECIPIENTS,
        maxAttachmentBytes: this.config.OPENSEND_MAX_ATTACHMENT_BYTES,
        maxScheduleDays: this.config.OPENSEND_MAX_SCHEDULE_DAYS,
        maxBatchSize: this.config.OPENSEND_MAX_BATCH_SIZE,
        maxPendingPerEnvironment: this.config.OPENSEND_MAX_PENDING_PER_ENVIRONMENT,
        rateLimitPerMinute: this.config.OPENSEND_RATE_LIMIT_PER_MINUTE,
      },
    };
  }
}
