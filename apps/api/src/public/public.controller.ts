import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import type { BatchResponse } from '@opensend/contracts';
import { uuidv7 } from '@opensend/core';
import type { Response } from 'express';
import { ApiKeyGuard, CurrentApiKey, requireScope, type ApiKeyContext } from '../auth/guards';
import { ApiError } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DomainsService, type DomainScope } from '../domains/domains.service';
import { AcceptanceService } from '../emails/acceptance.service';
import { EmailActionsService } from '../emails/email-actions.service';
import { EmailQueryService } from '../emails/email-query.service';
import { CONFIG } from '../infra/tokens';
import { UsageService } from '../usage/usage.service';

/** Public, versioned HTTP API authenticated with project/environment API keys. */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class PublicController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly acceptance: AcceptanceService,
    private readonly query: EmailQueryService,
    private readonly actions: EmailActionsService,
    private readonly domains: DomainsService,
    private readonly usage: UsageService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private scope(k: ApiKeyContext) {
    return { projectId: k.projectId, environmentId: k.environmentId };
  }
  private domainScope(k: ApiKeyContext): DomainScope {
    return {
      organizationId: k.organizationId,
      projectId: k.projectId,
      environmentId: k.environmentId,
      environmentKind: k.environmentKind,
    };
  }

  @Post('emails')
  async send(
    @CurrentApiKey() key: ApiKeyContext,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireScope(key, 'emails:send');
    await this.rateLimit.enforce(
      `key:${key.keyId}`,
      this.config.OPENSEND_RATE_LIMIT_PER_MINUTE,
      res,
    );
    const result = await this.acceptance.accept(
      { ...this.scope(key), apiKeyId: key.keyId },
      body,
      idempotencyKey,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post('emails/batch')
  async batch(
    @CurrentApiKey() key: ApiKeyContext,
    @Body() body: { emails?: unknown },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BatchResponse> {
    requireScope(key, 'emails:send');
    const items = Array.isArray(body?.emails) ? body.emails : null;
    if (!items || items.length === 0)
      throw new ApiError(
        'validation_error',
        'body must be { "emails": [ ... ] } with at least one email',
      );
    if (items.length > this.config.OPENSEND_MAX_BATCH_SIZE) {
      throw new ApiError(
        'validation_error',
        `at most ${this.config.OPENSEND_MAX_BATCH_SIZE} emails per batch`,
      );
    }
    if (idempotencyKey && idempotencyKey.length > 240)
      throw new ApiError('invalid_request', 'Idempotency-Key too long for batch use');
    await this.rateLimit.enforce(
      `key:${key.keyId}`,
      this.config.OPENSEND_RATE_LIMIT_PER_MINUTE,
      res,
    );
    const batchId = uuidv7();
    const out: BatchResponse = { object: 'batch', id: batchId, data: [], errors: [] };
    // Each item is accepted in its own transaction: one invalid item does not block the others.
    // With an Idempotency-Key every item gets the derived key `<key>#<index>`, so retrying the
    // whole batch returns the same email ids and never duplicates accepted items.
    for (const [index, item] of items.entries()) {
      try {
        const r = await this.acceptance.accept(
          { ...this.scope(key), apiKeyId: key.keyId, batchId },
          item,
          idempotencyKey ? `${idempotencyKey}#${index}` : undefined,
          'emails.batch',
        );
        out.data.push({ index, id: r.body.id, status: r.body.status });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        out.errors.push({
          index,
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
    }
    res.status(out.data.length > 0 ? 202 : 422);
    return out;
  }

  @Get('emails')
  list(@CurrentApiKey() key: ApiKeyContext, @Query() query: Record<string, string>) {
    requireScope(key, 'emails:read');
    return this.query.list(this.scope(key), query);
  }

  @Get('emails/:id')
  get(@CurrentApiKey() key: ApiKeyContext, @Param('id') id: string) {
    requireScope(key, 'emails:read');
    return this.query.get(this.scope(key), id);
  }

  @Post('emails/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentApiKey() key: ApiKeyContext, @Param('id') id: string) {
    requireScope(key, 'emails:send');
    return this.actions.cancel(this.scope(key), id, {
      type: 'api_key',
      id: key.keyId,
      organizationId: key.organizationId,
    });
  }

  @Get('domains')
  async listDomains(@CurrentApiKey() key: ApiKeyContext) {
    requireScope(key, 'domains:read');
    return {
      object: 'list',
      data: await this.domains.list(this.domainScope(key)),
      nextCursor: null,
    };
  }

  @Post('domains')
  @HttpCode(201)
  createDomain(@CurrentApiKey() key: ApiKeyContext, @Body() body: unknown) {
    requireScope(key, 'domains:manage');
    return this.domains.create(this.domainScope(key), body, { type: 'api_key', id: key.keyId });
  }

  @Get('domains/:id')
  getDomain(@CurrentApiKey() key: ApiKeyContext, @Param('id') id: string) {
    requireScope(key, 'domains:read');
    return this.domains.get(this.domainScope(key), id);
  }

  @Post('domains/:id/verify')
  @HttpCode(200)
  verifyDomain(@CurrentApiKey() key: ApiKeyContext, @Param('id') id: string) {
    requireScope(key, 'domains:manage');
    return this.domains.verify(this.domainScope(key), id);
  }

  @Get('usage')
  getUsage(@CurrentApiKey() key: ApiKeyContext) {
    requireScope(key, 'usage:read');
    return this.usage.get(key.projectId, key.environmentId);
  }
}
