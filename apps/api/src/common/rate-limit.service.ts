import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@opensend/core';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { LOGGER, REDIS } from '../infra/tokens';
import { ApiError } from './errors';

/**
 * Sliding-window counter (weighted previous + current window), evaluated atomically in Redis.
 * A request is only counted when it is allowed, so rejected requests do not consume capacity.
 * Returns { allowed, estimate }.
 */
const SLIDING_WINDOW = `
local cur = KEYS[1]
local prev = KEYS[2]
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local c = tonumber(redis.call('GET', cur) or '0')
local p = tonumber(redis.call('GET', prev) or '0')
local used = p * weight + c
if used + cost > limit then
  return {0, math.floor(used)}
end
redis.call('INCRBY', cur, cost)
redis.call('EXPIRE', cur, ttl)
return {1, math.floor(used + cost)}
`;

export interface RateLimitRule {
  bucket: string;
  limit: number;
}

/**
 * Request rate limits (abuse protection). Quotas and backlog limits are enforced
 * transactionally in PostgreSQL and do not depend on Redis. High-cost public writes fail
 * closed if Redis is unavailable so an infrastructure incident cannot remove abuse controls.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Checks every rule in order with the given cost (e.g. number of emails in a batch). */
  async enforceAll(
    rules: RateLimitRule[],
    res?: Response,
    cost = 1,
    windowSeconds = 60,
  ): Promise<void> {
    for (const rule of rules) await this.enforce(rule.bucket, rule.limit, res, cost, windowSeconds);
  }

  async enforce(
    bucket: string,
    limit: number,
    res?: Response,
    cost = 1,
    windowSeconds = 60,
  ): Promise<void> {
    const nowSec = Date.now() / 1000;
    const window = Math.floor(nowSec / windowSeconds);
    const elapsed = (nowSec % windowSeconds) / windowSeconds;
    const key = (w: number) => `opensend:rl:${bucket}:${w}`;
    let allowed: number;
    let used: number;
    try {
      const out = (await this.redis.eval(
        SLIDING_WINDOW,
        2,
        key(window),
        key(window - 1),
        cost,
        limit,
        (1 - elapsed).toFixed(4),
        windowSeconds * 2 + 5,
      )) as [number, number];
      [allowed, used] = out;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, bucket },
        'rate limiter unavailable, rejecting request',
      );
      throw new ApiError('service_unavailable', 'rate limiter temporarily unavailable');
    }
    const reset = Math.ceil(windowSeconds - (nowSec % windowSeconds));
    if (res) {
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - used)));
      res.setHeader('RateLimit-Reset', String(reset));
    }
    if (!allowed) {
      res?.setHeader('Retry-After', String(reset));
      throw new ApiError('rate_limited', 'rate limit exceeded', {
        limit,
        retryAfterSeconds: reset,
        scope: bucket.split(':')[0],
      });
    }
  }
}
