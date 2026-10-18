import { Inject, Injectable } from '@nestjs/common';
import { CANCELLABLE_STATUSES } from '@opensend/contracts';
import { writeAudit, type Logger, type ObjectStore } from '@opensend/core';
import {
  environments,
  eq,
  organizations,
  projects,
  sql,
  type Database,
  type Tx,
} from '@opensend/db';
import type { EnvironmentAccess, OrgAccess, ProjectAccess } from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { ApiError } from '../common/errors';
import { DB, LOGGER, OBJECT_STORE } from '../infra/tokens';

type Scope =
  | { kind: 'environment'; organizationId: string; projectId: string; environmentId: string }
  | { kind: 'project'; organizationId: string; projectId: string }
  | { kind: 'organization'; organizationId: string };

const PENDING = sql`('accepted', 'scheduled', 'queued', 'submitting', 'retry_wait')`;
const CANCELLABLE = sql.raw(`(${CANCELLABLE_STATUSES.map((s) => `'${s}'`).join(', ')})`);

/**
 * The one place that deletes tenant scopes (environment, project, organization).
 *
 * 1. Emails still in progress block the deletion (an email being handed off right now can
 *    never be recalled). Waiting emails can be cancelled first with `cancelPending`.
 * 2. Attachment objects of the scope are deleted from object storage.
 * 3. All rows of the scope are deleted in ONE transaction that locks the remaining email rows,
 *    so a worker cannot claim an email of the scope concurrently.
 * Every statement is bound to the scope's own ids; nothing outside the scope is touched.
 */
@Injectable()
export class DeletionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private emailFilter(scope: Scope) {
    switch (scope.kind) {
      case 'environment':
        return sql`environment_id = ${scope.environmentId} AND project_id = ${scope.projectId}`;
      case 'project':
        return sql`project_id = ${scope.projectId}`;
      case 'organization':
        return sql`project_id IN (SELECT id FROM projects WHERE organization_id = ${scope.organizationId})`;
    }
  }

  async deleteEnvironment(
    a: EnvironmentAccess,
    u: SessionUser,
    cancelPending: boolean,
    ip: string | null,
  ) {
    const count = await this.db.$count(environments, eq(environments.projectId, a.project.id));
    if (count <= 1)
      throw new ApiError(
        'conflict',
        'a project needs at least one environment; delete the project instead',
      );
    const scope: Scope = {
      kind: 'environment',
      organizationId: a.organizationId,
      projectId: a.project.id,
      environmentId: a.environment.id,
    };
    return this.run(scope, cancelPending, async (tx) => {
      await tx.delete(environments).where(eq(environments.id, a.environment.id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'environment.delete',
        targetType: 'environment',
        targetId: a.environment.id,
        metadata: { name: a.environment.name, kind: a.environment.kind },
        ipAddress: ip,
      });
    });
  }

  async deleteProject(a: ProjectAccess, u: SessionUser, cancelPending: boolean, ip: string | null) {
    const scope: Scope = {
      kind: 'project',
      organizationId: a.organizationId,
      projectId: a.project.id,
    };
    return this.run(scope, cancelPending, async (tx) => {
      await tx.execute(sql`DELETE FROM usage_periods WHERE project_id = ${a.project.id}`);
      await tx.delete(projects).where(eq(projects.id, a.project.id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        actorType: 'user',
        actorId: u.id,
        action: 'project.delete',
        targetType: 'project',
        targetId: a.project.id,
        metadata: { name: a.project.name },
        ipAddress: ip,
      });
    });
  }

  async deleteOrganization(
    access: OrgAccess,
    u: SessionUser,
    cancelPending: boolean,
    ip: string | null,
  ) {
    const [org] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, access.organizationId));
    if (!org) throw new ApiError('not_found', 'organization not found');
    const scope: Scope = { kind: 'organization', organizationId: org.id };
    return this.run(scope, cancelPending, async (tx) => {
      // The organization's own audit trail goes with it; one instance-level entry remains.
      await tx.execute(sql`DELETE FROM audit_logs WHERE organization_id = ${org.id}`);
      await tx.delete(organizations).where(eq(organizations.id, org.id));
      await writeAudit(tx, {
        organizationId: null,
        actorType: 'user',
        actorId: u.id,
        action: 'organization.delete',
        targetType: 'organization',
        targetId: org.id,
        metadata: { name: org.name },
        ipAddress: ip,
      });
    });
  }

  private async run(scope: Scope, cancelPending: boolean, deleteRoot: (tx: Tx) => Promise<void>) {
    const filter = this.emailFilter(scope);

    if (cancelPending) {
      await this.db.execute(sql`
        UPDATE emails SET status = 'cancelled', cancelled_at = now(), finalized_at = now(), updated_at = now()
         WHERE ${filter} AND status IN ${CANCELLABLE}`);
    }
    const pending = await this.db.execute<{ status: string; n: number }>(sql`
      SELECT status, count(*)::int AS n FROM emails WHERE ${filter} AND status IN ${PENDING} GROUP BY status`);
    if (pending.rows.length > 0) {
      const byStatus = Object.fromEntries(pending.rows.map((r) => [r.status, Number(r.n)]));
      throw new ApiError(
        'conflict',
        byStatus.submitting
          ? 'emails are being handed to the provider right now; try again in a minute'
          : 'there are emails waiting to be sent; cancel them first (cancelPending=true)',
        { pending: byStatus },
      );
    }

    // Objects first: if storage fails, nothing has been deleted yet and the request can be retried.
    const objects = await this.db.execute<{ object_key: string }>(sql`
      SELECT object_key FROM email_attachments
       WHERE purged_at IS NULL AND email_id IN (SELECT id FROM emails WHERE ${filter})`);
    for (const o of objects.rows) {
      try {
        await this.store.delete(o.object_key);
      } catch (err) {
        this.logger.error(
          { err: (err as Error).message },
          'object deletion failed; scope deletion aborted',
        );
        throw new ApiError(
          'service_unavailable',
          'attachments could not be deleted from object storage; nothing was deleted, try again',
        );
      }
    }

    const counts = await this.db.transaction(async (tx) => {
      // Lock the remaining emails: a worker cannot claim one of them until we commit.
      const locked = await tx.execute<{ id: string }>(
        sql`SELECT id FROM emails WHERE ${filter} FOR UPDATE`,
      );
      const again = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM emails WHERE ${filter} AND status IN ${PENDING}`,
      );
      if (Number(again.rows[0]?.n ?? 0) > 0)
        throw new ApiError('conflict', 'new emails were accepted meanwhile; try again');

      // Rows without a foreign key to the scope root.
      const connFilter = this.connectionFilter(scope);
      await tx.execute(sql`
        DELETE FROM outbox WHERE completed_at IS NULL AND (
             ref_id IN (SELECT id FROM emails WHERE ${filter})
          OR ref_id IN (SELECT d.id FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE ${this.endpointFilter(scope)})
          OR ref_id IN (SELECT id FROM provider_events WHERE provider_connection_id IN (SELECT id FROM provider_connections WHERE ${connFilter})))`);
      await tx.execute(
        sql`DELETE FROM provider_events WHERE provider_connection_id IN (SELECT id FROM provider_connections WHERE ${connFilter})`,
      );
      await tx.execute(sql`DELETE FROM webhook_events WHERE ${filter}`);
      await tx.execute(sql`DELETE FROM idempotency_keys WHERE ${filter}`);
      await tx.execute(sql`DELETE FROM usage_ledger WHERE ${filter}`);
      await deleteRoot(tx);
      return { emails: locked.rows.length, objects: objects.rows.length };
    });
    this.logger.info({ scope, ...counts }, 'scope deleted');
    return { deleted: true, ...counts };
  }

  private connectionFilter(scope: Scope) {
    return this.emailFilter(scope);
  }

  private endpointFilter(scope: Scope) {
    switch (scope.kind) {
      case 'environment':
        return sql`w.environment_id = ${scope.environmentId} AND w.project_id = ${scope.projectId}`;
      case 'project':
        return sql`w.project_id = ${scope.projectId}`;
      case 'organization':
        return sql`w.project_id IN (SELECT id FROM projects WHERE organization_id = ${scope.organizationId})`;
    }
  }
}
