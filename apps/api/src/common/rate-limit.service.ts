import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@opensend/core';
import type Redis from 'ioredis';
import type { Response } from 'express';
import { LOGGER, REDIS } from '../infra/tokens';
import { ApiError } from './errors';

/**
 * Fixed-window request rate limit in Redis. It is abuse protection only: quotas and
 * backlog limits are enforced transactionally in PostgreSQL and do not depend on Redis.
 * If Redis is unavailable the limiter fails open (logged), so acceptance stays possible.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async enforce(bucket: string, limit: number, res?: Response, windowSeconds = 60): Promise<void> {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `opensend:rl:${bucket}:${window}`;
    let count: number;
    try {
      const out = await this.redis
        .multi()
        .incr(key)
        .expire(key, windowSeconds + 5)
        .exec();
      count = Number(out?.[0]?.[1] ?? 0);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, bucket },
        'rate limiter unavailable, failing open',
      );
      return;
    }
    const reset = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    if (res) {
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.setHeader('RateLimit-Reset', String(reset));
    }
    if (count > limit) {
      res?.setHeader('Retry-After', String(reset));
      throw new ApiError('rate_limited', 'rate limit exceeded', {
        limit,
        retryAfterSeconds: reset,
      });
    }
  }
}
