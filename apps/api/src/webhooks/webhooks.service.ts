import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import { WEBHOOK_EVENT_TYPES } from '@opensend/contracts';
import {
  KeyRing,
  assertHostnameShape,
  enqueueOutbox,
  generateWebhookSecret,
  writeAudit,
} from '@opensend/core';
import {
  and,
  desc,
  eq,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  webhookEvents,
  type Database,
} from '@opensend/db';
import { z } from 'zod';
import type { EnvironmentAccess } from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { ApiError, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { CONFIG, DB, KEYRING } from '../infra/tokens';

const createSchema = z.object({
  url: z.url().max(2048),
  description: z.string().max(200).optional(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});
const updateSchema = createSchema.partial().extend({ enabled: z.boolean().optional() });

type EndpointRow = typeof webhookEndpoints.$inferSelect;

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KEYRING) private readonly keys: KeyRing,
  ) {}

  /** Static URL checks; the authoritative SSRF check happens at connect time in the worker. */
  private checkUrl(raw: string) {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' &&
      !(this.config.OPENSEND_WEBHOOK_ALLOW_HTTP && url.protocol === 'http:')
    ) {
      throw new ApiError('validation_error', 'webhook URLs must use https://');
    }
    if (url.username || url.password)
      throw new ApiError('validation_error', 'credentials in webhook URLs are not allowed');
    try {
      assertHostnameShape(url.hostname.replace(/^\[|\]$/g, ''), {
        privateHostAllowlist: this.config.OPENSEND_PRIVATE_NETWORK_ALLOWLIST,
      });
    } catch (err) {
      throw new ApiError('validation_error', (err as Error).message);
    }
  }

  private view(e: EndpointRow) {
    return {
      id: e.id,
      url: e.url,
      description: e.description,
      eventTypes: e.eventTypes,
      enabled: e.enabled,
      rotating: Boolean(
        e.previousSecretExpiresAt && e.previousSecretExpiresAt.getTime() > Date.now(),
      ),
      createdAt: e.createdAt.toISOString(),
    };
  }

  async list(a: EnvironmentAccess) {
    const rows = await this.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.projectId, a.project.id),
          eq(webhookEndpoints.environmentId, a.environment.id),
        ),
      )
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map((r) => this.view(r));
  }

  private async load(a: EnvironmentAccess, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('webhook endpoint');
    const [e] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.projectId, a.project.id),
          eq(webhookEndpoints.environmentId, a.environment.id),
        ),
      )
      .limit(1);
    if (!e) throw notFound('webhook endpoint');
    return e;
  }

  /** Secret is shown once at creation and on rotation. */
  async create(a: EnvironmentAccess, u: SessionUser, raw: unknown) {
    const input = parseOrThrow(createSchema, raw);
    this.checkUrl(input.url);
    const secret = generateWebhookSecret();
    const row = await this.db.transaction(async (tx) => {
      const [e] = await tx
        .insert(webhookEndpoints)
        .values({
          projectId: a.project.id,
          environmentId: a.environment.id,
          url: input.url,
          description: input.description ?? null,
          eventTypes: input.eventTypes,
          secretCiphertext: 'pending',
        })
        .returning();
      await tx
        .update(webhookEndpoints)
        .set({ secretCiphertext: this.keys.encrypt(secret, `webhook_secret:${e!.id}`) })
        .where(eq(webhookEndpoints.id, e!.id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'webhook.create',
        targetType: 'webhook_endpoint',
        targetId: e!.id,
        metadata: { url: input.url },
      });
      return e!;
    });
    return { ...this.view(row), secret };
  }

  async update(a: EnvironmentAccess, u: SessionUser, id: string, raw: unknown) {
    const input = parseOrThrow(updateSchema, raw);
    const e = await this.load(a, id);
    if (input.url) this.checkUrl(input.url);
    const [row] = await this.db
      .update(webhookEndpoints)
      .set({
        url: input.url ?? e.url,
        description: input.description ?? e.description,
        eventTypes: input.eventTypes ?? e.eventTypes,
        enabled: input.enabled ?? e.enabled,
        updatedAt: new Date(),
      })
      .where(eq(webhookEndpoints.id, e.id))
      .returning();
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'webhook.update',
      targetType: 'webhook_endpoint',
      targetId: e.id,
      metadata: { fields: Object.keys(input) },
    });
    return this.view(row!);
  }

  /** New secret becomes primary; the previous one keeps signing (second signature) for 24 h. */
  async rotate(a: EnvironmentAccess, u: SessionUser, id: string) {
    const e = await this.load(a, id);
    const secret = generateWebhookSecret();
    const previous = this.keys.decrypt(e.secretCiphertext, `webhook_secret:${e.id}`);
    await this.db.transaction(async (tx) => {
      await tx
        .update(webhookEndpoints)
        .set({
          secretCiphertext: this.keys.encrypt(secret, `webhook_secret:${e.id}`),
          previousSecretCiphertext: this.keys.encrypt(previous, `webhook_secret_prev:${e.id}`),
          previousSecretExpiresAt: new Date(Date.now() + 24 * 3_600_000),
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, e.id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'webhook.rotate_secret',
        targetType: 'webhook_endpoint',
        targetId: e.id,
      });
    });
    return {
      secret,
      previousSecretValidUntil: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    };
  }

  async remove(a: EnvironmentAccess, u: SessionUser, id: string) {
    const e = await this.load(a, id);
    await this.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, e.id));
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'webhook.delete',
      targetType: 'webhook_endpoint',
      targetId: e.id,
    });
  }

  /** Sends a signed `webhook.test` event to this endpoint only. */
  async test(a: EnvironmentAccess, id: string) {
    const e = await this.load(a, id);
    return this.db.transaction(async (tx) => {
      const [ev] = await tx
        .insert(webhookEvents)
        .values({
          projectId: a.project.id,
          environmentId: a.environment.id,
          type: 'webhook.test',
          occurredAt: new Date(),
          payload: { message: 'This is a test event from OpenSend.' },
        })
        .returning();
      const [d] = await tx
        .insert(webhookDeliveries)
        .values({ webhookEventId: ev!.id, endpointId: e.id, projectId: a.project.id, kind: 'test' })
        .returning();
      await enqueueOutbox(tx, { kind: 'deliver_webhook', refId: d!.id, projectId: a.project.id });
      return { deliveryId: d!.id, eventId: ev!.id };
    });
  }

  async deliveries(a: EnvironmentAccess, id: string, status?: string) {
    const e = await this.load(a, id);
    const conds = [
      eq(webhookDeliveries.endpointId, e.id),
      eq(webhookDeliveries.projectId, a.project.id),
    ];
    if (status && ['pending', 'succeeded', 'retry_wait', 'dead'].includes(status))
      conds.push(eq(webhookDeliveries.status, status as 'dead'));
    const rows = await this.db
      .select({ d: webhookDeliveries, type: webhookEvents.type, eventId: webhookEvents.id })
      .from(webhookDeliveries)
      .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.webhookEventId))
      .where(and(...conds))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.d.id,
      eventId: r.eventId,
      eventType: r.type,
      kind: r.d.kind,
      status: r.d.status,
      attempts: r.d.attemptCount,
      lastStatusCode: r.d.lastStatusCode,
      lastError: r.d.lastError,
      nextAttemptAt: r.d.nextAttemptAt?.toISOString() ?? null,
      lastAttemptAt: r.d.lastAttemptAt?.toISOString() ?? null,
      createdAt: r.d.createdAt.toISOString(),
    }));
  }

  async deliveryAttempts(a: EnvironmentAccess, deliveryId: string) {
    const d = await this.loadDelivery(a, deliveryId);
    const rows = await this.db
      .select()
      .from(webhookDeliveryAttempts)
      .where(eq(webhookDeliveryAttempts.deliveryId, d.id))
      .orderBy(webhookDeliveryAttempts.attemptNumber);
    return rows.map((r) => ({
      number: r.attemptNumber,
      statusCode: r.statusCode,
      error: r.error,
      durationMs: r.durationMs,
      startedAt: r.startedAt.toISOString(),
    }));
  }

  private async loadDelivery(a: EnvironmentAccess, deliveryId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw notFound('delivery');
    const [d] = await this.db
      .select({ d: webhookDeliveries })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookEndpoints.projectId, a.project.id),
          eq(webhookEndpoints.environmentId, a.environment.id),
        ),
      )
      .limit(1);
    if (!d) throw notFound('delivery');
    return d.d;
  }

  /** Replays the SAME event (same event id) as a new delivery. Never sends an email. */
  async replay(a: EnvironmentAccess, u: SessionUser, deliveryId: string) {
    const d = await this.loadDelivery(a, deliveryId);
    return this.db.transaction(async (tx) => {
      const [nd] = await tx
        .insert(webhookDeliveries)
        .values({
          webhookEventId: d.webhookEventId,
          endpointId: d.endpointId,
          projectId: d.projectId,
          kind: 'replay',
        })
        .returning();
      await enqueueOutbox(tx, { kind: 'deliver_webhook', refId: nd!.id, projectId: d.projectId });
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'webhook.replay',
        targetType: 'webhook_delivery',
        targetId: d.id,
        metadata: { newDeliveryId: nd!.id },
      });
      return { deliveryId: nd!.id };
    });
  }
}
