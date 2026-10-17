import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import { enqueueOutbox, type Logger } from '@opensend/core';
import { and, eq, providerConnections, providerEvents, type Database } from '@opensend/db';
import {
  SnsVerificationError,
  isTrustedSnsUrl,
  normalizeSesEvent,
  verifySnsMessage,
  type CertFetcher,
} from '@opensend/providers';
import { fetch as undiciFetch } from 'undici';
import { ApiError } from '../common/errors';
import { CONFIG, DB, LOGGER } from '../infra/tokens';

export const SNS_CERT_FETCHER = Symbol('SNS_CERT_FETCHER');

/**
 * Inbound Amazon SES events via SNS (HTTPS subscription). Only signed messages from topics
 * configured for THIS connection are accepted. Every verified notification is stored before
 * processing, so an event that cannot be matched yet is never lost.
 */
@Controller('webhooks/ses')
export class SesEventsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SNS_CERT_FETCHER) private readonly fetchCert: CertFetcher | null,
  ) {}

  @Post(':connectionId')
  @HttpCode(200)
  async receive(@Param('connectionId') connectionId: string, @Body() rawBody: unknown) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new ApiError('not_found', 'unknown endpoint');
    const [connection] = await this.db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.id, connectionId), eq(providerConnections.type, 'ses')))
      .limit(1);
    if (!connection) throw new ApiError('not_found', 'unknown endpoint');
    const body = typeof rawBody === 'string' ? safeJson(rawBody) : rawBody;
    const topics = [
      ...((connection.config as { snsTopicArns?: string[] }).snsTopicArns ?? []),
      ...this.config.OPENSEND_SES_ALLOWED_TOPIC_ARNS,
    ];
    let msg;
    try {
      msg = await verifySnsMessage(body, {
        allowedTopicArns: topics,
        fetchCert: this.fetchCert ?? undefined,
      });
    } catch (err) {
      if (err instanceof SnsVerificationError) {
        this.logger.warn({ connectionId, reason: err.message }, 'rejected SNS message');
        throw new ApiError('forbidden', 'message verification failed');
      }
      throw err;
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      if (!msg.SubscribeURL || !isTrustedSnsUrl(msg.SubscribeURL, 'subscribe'))
        throw new ApiError('forbidden', 'untrusted SubscribeURL');
      const res = await undiciFetch(msg.SubscribeURL, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      this.logger.info(
        { connectionId, topic: msg.TopicArn, status: res.status },
        'confirmed SNS subscription',
      );
      return { ok: true, confirmed: res.ok };
    }
    if (msg.Type === 'UnsubscribeConfirmation') return { ok: true };

    const event = normalizeSesEvent(msg.MessageId, msg.Message);
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(providerEvents)
        .values({
          provider: 'ses',
          providerConnectionId: connection.id,
          externalId: event.externalId,
          providerMessageId: event.providerMessageId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          payload: { ...event.payload, recipients: event.recipients },
          matchStatus:
            event.eventType === 'other' || event.eventType === 'sent' ? 'ignored' : 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: providerEvents.id, matchStatus: providerEvents.matchStatus });
      // Duplicate deliveries of the same SNS message are acknowledged and ignored.
      if (inserted[0] && inserted[0].matchStatus === 'pending') {
        await enqueueOutbox(tx, {
          kind: 'process_provider_event',
          refId: inserted[0].id,
          projectId: connection.projectId,
        });
      }
    });
    return { ok: true };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
