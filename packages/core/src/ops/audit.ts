import { auditLogs, type DbOrTx } from '@opensend/db';

export interface AuditEntry {
  organizationId?: string | null;
  projectId?: string | null;
  actorType: 'user' | 'api_key' | 'system' | 'platform_admin';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Never put secrets or message content here. */
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAudit(tx: DbOrTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    organizationId: entry.organizationId ?? null,
    projectId: entry.projectId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.ipAddress ?? null,
  });
}
