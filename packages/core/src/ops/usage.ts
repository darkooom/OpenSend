import { sql, usageLedger, type DbOrTx } from '@opensend/db';

export function usagePeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export class QuotaExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super('monthly recipient quota exceeded');
  }
}

/**
 * Atomically reserve quota for an accepted email inside the acceptance transaction.
 * The conditional UPDATE serializes concurrent requests on the period row, so parallel
 * requests cannot overshoot the limit. If the surrounding transaction rolls back
 * (validation error, idempotency conflict, ...), the reservation disappears with it.
 */
export async function reserveRecipientQuota(
  tx: DbOrTx,
  input: {
    projectId: string;
    environmentId: string;
    emailId: string;
    recipients: number;
    limit: number;
    period?: string;
  },
): Promise<void> {
  const period = input.period ?? usagePeriod();
  await tx.execute(sql`
    INSERT INTO usage_periods (project_id, period, accepted_emails, accepted_recipients)
    VALUES (${input.projectId}, ${period}, 0, 0)
    ON CONFLICT (project_id, period) DO NOTHING`);
  const res = await tx.execute<{ accepted_recipients: number }>(sql`
    UPDATE usage_periods
       SET accepted_emails = accepted_emails + 1,
           accepted_recipients = accepted_recipients + ${input.recipients},
           updated_at = now()
     WHERE project_id = ${input.projectId}
       AND period = ${period}
       AND accepted_recipients + ${input.recipients} <= ${input.limit}
     RETURNING accepted_recipients`);
  if (res.rows.length === 0) {
    const cur = await tx.execute<{ accepted_recipients: number }>(
      sql`SELECT accepted_recipients FROM usage_periods WHERE project_id = ${input.projectId} AND period = ${period}`,
    );
    throw new QuotaExceededError(input.limit, Number(cur.rows[0]?.accepted_recipients ?? 0));
  }
  await tx.insert(usageLedger).values({
    projectId: input.projectId,
    environmentId: input.environmentId,
    period,
    emailId: input.emailId,
    kind: 'accepted_recipients',
    quantity: input.recipients,
  });
}
