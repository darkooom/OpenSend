import { and, eq, inArray, platformSuppressions, suppressions, type DbOrTx } from '@opensend/db';

export async function addSuppression(
  tx: DbOrTx,
  input: {
    projectId: string;
    environmentId: string;
    address: string;
    reason: 'hard_bounce' | 'complaint' | 'manual';
    sourceEmailId?: string;
    note?: string;
  },
): Promise<void> {
  await tx
    .insert(suppressions)
    .values({
      projectId: input.projectId,
      environmentId: input.environmentId,
      address: input.address.toLowerCase(),
      reason: input.reason,
      sourceEmailId: input.sourceEmailId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Returns the suppressed subset of `addresses` for an environment. Platform entries are
 * reported with reason `policy` only – tenants never learn why or from whom.
 */
export async function findSuppressed(
  tx: DbOrTx,
  environmentId: string,
  addresses: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (addresses.length === 0) return out;
  const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const tenant = await tx
    .select({ address: suppressions.address, reason: suppressions.reason })
    .from(suppressions)
    .where(
      and(eq(suppressions.environmentId, environmentId), inArray(suppressions.address, lower)),
    );
  for (const r of tenant) out.set(r.address, r.reason);
  const platform = await tx
    .select({ address: platformSuppressions.address })
    .from(platformSuppressions)
    .where(inArray(platformSuppressions.address, lower));
  for (const r of platform) if (!out.has(r.address)) out.set(r.address, 'policy');
  return out;
}
