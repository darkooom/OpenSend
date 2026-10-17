import { WEBHOOK_HEADERS } from '@opensend/contracts';
import {
  BlockedTargetError,
  backoffDelayMs,
  enqueueOutbox,
  redact,
  safeFetch,
  signatureHeader,
} from '@opensend/core';
import {
  eq,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  webhookEvents,
} from '@opensend/db';
import type { WorkerDeps } from './deps';
import { completeOutbox } from './dispatcher';

export type WebhookOutcome = 'succeeded' | 'retry_scheduled' | 'dead' | 'skipped';

/**
 * Delivers one webhook. Runs in its own queue, so slow receivers never block sending.
 * Deliveries are at-least-once and may arrive out of order; receivers dedupe on the event id.
 */
export async function processWebhookDelivery(
  deps: WorkerDeps,
  deliveryId: string,
  outboxId?: number,
  opts: { lookup?: Parameters<typeof safeFetch>[1]['lookup'] } = {},
): Promise<WebhookOutcome> {
  const { db, config } = deps;
  const [row] = await db
    .select({ d: webhookDeliveries, e: webhookEndpoints, ev: webhookEvents })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.webhookEventId))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  if (!row || row.d.status === 'succeeded' || row.d.status === 'dead') {
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'skipped';
  }
  // Defence in depth: endpoint and event must belong to the same project/environment.
  if (row.e.projectId !== row.ev.projectId || row.e.environmentId !== row.ev.environmentId) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'dead', lastError: 'project mismatch', completedAt: new Date() })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'dead';
  }
  if (!row.e.enabled && row.d.kind === 'event') {
    await db
      .update(webhookDeliveries)
      .set({ status: 'dead', lastError: 'endpoint disabled', completedAt: new Date() })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (outboxId) await completeOutbox(deps, outboxId);
    return 'dead';
  }

  const body = JSON.stringify({
    id: row.ev.id,
    type: row.ev.type,
    version: row.ev.version,
    createdAt: row.ev.occurredAt.toISOString(),
    projectId: row.ev.projectId,
    environmentId: row.ev.environmentId,
    data: row.ev.payload,
  });
  const secrets = [deps.keys.decrypt(row.e.secretCiphertext, `webhook_secret:${row.e.id}`)];
  if (
    row.e.previousSecretCiphertext &&
    row.e.previousSecretExpiresAt &&
    row.e.previousSecretExpiresAt.getTime() > Date.now()
  ) {
    secrets.push(
      deps.keys.decrypt(row.e.previousSecretCiphertext, `webhook_secret_prev:${row.e.id}`),
    );
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const attemptNumber = row.d.attemptCount + 1;
  const started = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  let permanent = false;
  try {
    const res = await safeFetch(row.e.url, {
      method: 'POST',
      timeoutMs: config.OPENSEND_WEBHOOK_TIMEOUT_MS,
      allowHttp: config.OPENSEND_WEBHOOK_ALLOW_HTTP,
      privateHostAllowlist: config.OPENSEND_PRIVATE_NETWORK_ALLOWLIST,
      lookup: opts.lookup,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'OpenSend-Webhooks/1',
        [WEBHOOK_HEADERS.id]: row.ev.id,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: signatureHeader(secrets, row.ev.id, timestamp, body),
      },
      body,
    });
    statusCode = res.status;
    if (res.status >= 300 && res.status < 400) error = 'redirects are not followed';
    else if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = redact((err as Error).message) ?? 'request failed';
    if (err instanceof BlockedTargetError) permanent = true;
  }
  const durationMs = Date.now() - started;
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;

  const outcome = await db.transaction(async (tx) => {
    await tx
      .insert(webhookDeliveryAttempts)
      .values({ deliveryId, attemptNumber, statusCode, error, durationMs })
      .onConflictDoNothing();
    if (ok) {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          attemptCount: attemptNumber,
          lastStatusCode: statusCode,
          lastError: null,
          lastAttemptAt: new Date(),
          completedAt: new Date(),
          nextAttemptAt: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      return 'succeeded' as const;
    }
    const maxAttempts = row.d.kind === 'test' ? 1 : config.OPENSEND_MAX_WEBHOOK_ATTEMPTS;
    if (permanent || attemptNumber >= maxAttempts) {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'dead',
          attemptCount: attemptNumber,
          lastStatusCode: statusCode,
          lastError: error,
          lastAttemptAt: new Date(),
          completedAt: new Date(),
          nextAttemptAt: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      return 'dead' as const;
    }
    const next = new Date(
      Date.now() + backoffDelayMs(attemptNumber, { baseMs: 10_000, maxMs: 6 * 3_600_000 }),
    );
    await tx
      .update(webhookDeliveries)
      .set({
        status: 'retry_wait',
        attemptCount: attemptNumber,
        lastStatusCode: statusCode,
        lastError: error,
        lastAttemptAt: new Date(),
        nextAttemptAt: next,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    await enqueueOutbox(tx, {
      kind: 'deliver_webhook',
      refId: deliveryId,
      projectId: row.d.projectId,
      availableAt: next,
    });
    return 'retry_scheduled' as const;
  });
  if (outboxId) await completeOutbox(deps, outboxId);
  return outcome;
}
