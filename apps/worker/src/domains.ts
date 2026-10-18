import { promises as dnsPromises } from 'node:dns';
import { writeAudit } from '@opensend/core';
import { domains, eq, projects, sql } from '@opensend/db';
import type { WorkerDeps } from './deps';

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[]>;
}

/** System resolver; "no such record" is an empty answer, other DNS failures throw. */
export const systemTxtResolver: TxtResolver = {
  async resolveTxt(name) {
    try {
      return (await dnsPromises.resolveTxt(name)).map((c) => c.join(''));
    } catch (err) {
      if (['ENODATA', 'ENOTFOUND'].includes((err as NodeJS.ErrnoException).code ?? '')) return [];
      throw err;
    }
  },
};

export const OWNERSHIP_GRACE_HOURS = 72;

/**
 * Periodic ownership re-check of verified domains (default: each domain once per 24 h).
 * A missing TXT record is flagged immediately; ownership — and therefore sending — is revoked
 * only after it stayed missing for OWNERSHIP_GRACE_HOURS. DNS failures (timeouts, SERVFAIL)
 * never count as "missing". Nothing is deleted.
 */
export async function recheckDomainOwnership(
  deps: WorkerDeps,
  opts: { resolver?: TxtResolver; olderThanHours?: number; limit?: number } = {},
): Promise<{ checked: number; missing: number; revoked: number }> {
  const resolver = opts.resolver ?? systemTxtResolver;
  const due = await deps.db
    .select({ domain: domains, organizationId: projects.organizationId })
    .from(domains)
    .innerJoin(projects, eq(projects.id, domains.projectId))
    .where(
      sql`${domains.localOnly} = false AND ${domains.ownershipVerifiedAt} IS NOT NULL
          AND (${domains.ownershipCheckedAt} IS NULL OR ${domains.ownershipCheckedAt} < now() - make_interval(hours => ${opts.olderThanHours ?? 24}))`,
    )
    .limit(opts.limit ?? 100);
  const result = { checked: 0, missing: 0, revoked: 0 };
  for (const { domain: d, organizationId } of due) {
    const name = `_opensend.${d.name}`;
    let records: string[];
    try {
      records = await resolver.resolveTxt(name);
    } catch (err) {
      deps.logger.warn(
        { domainId: d.id, err: (err as Error).message },
        'domain re-check skipped: DNS lookup failed',
      );
      continue;
    }
    result.checked++;
    const now = new Date();
    if (records.some((r) => r.trim() === `opensend-verification=${d.ownershipToken}`)) {
      await deps.db
        .update(domains)
        .set({ ownershipCheckedAt: now, ownershipMissingSince: null, ownershipLastError: null })
        .where(eq(domains.id, d.id));
      continue;
    }
    result.missing++;
    const missingSince = d.ownershipMissingSince ?? now;
    const revoke = now.getTime() - missingSince.getTime() >= OWNERSHIP_GRACE_HOURS * 3_600_000;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(domains)
        .set({
          ownershipCheckedAt: now,
          ownershipMissingSince: revoke ? null : missingSince,
          ownershipVerifiedAt: revoke ? null : d.ownershipVerifiedAt,
          ownershipLastError: revoke
            ? `ownership revoked: TXT record at ${name} was missing for more than ${OWNERSHIP_GRACE_HOURS} hours`
            : `TXT record at ${name} not found since ${missingSince.toISOString()}; sending stops after ${OWNERSHIP_GRACE_HOURS} hours`,
          updatedAt: now,
        })
        .where(eq(domains.id, d.id));
      if (revoke) {
        await writeAudit(tx, {
          organizationId,
          projectId: d.projectId,
          actorType: 'system',
          action: 'domain.ownership_revoked',
          targetType: 'domain',
          targetId: d.id,
          metadata: { name: d.name, missingSince: missingSince.toISOString() },
        });
      }
    });
    if (revoke) result.revoked++;
  }
  return result;
}
