import { outbox, type DbOrTx } from '@opensend/db';

export type OutboxKind = 'send_email' | 'deliver_webhook' | 'process_provider_event';

/** Must be called inside the same transaction that creates/updates the referenced row. */
export async function enqueueOutbox(
  tx: DbOrTx,
  entry: { kind: OutboxKind; refId: string; projectId: string; availableAt?: Date },
): Promise<void> {
  await tx.insert(outbox).values({
    kind: entry.kind,
    refId: entry.refId,
    projectId: entry.projectId,
    availableAt: entry.availableAt ?? new Date(),
  });
}
