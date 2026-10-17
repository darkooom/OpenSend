import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { ApiKeyScope } from '@opensend/contracts';
import { safeEqualHex, parseApiKey, sha256Hex } from '@opensend/core';
import { and, apiKeys, environments, eq, isNull, projects, sql, type Database } from '@opensend/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { ApiError } from '../common/errors';
import { AUTH, DB } from '../infra/tokens';
import type { Auth } from './auth';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  platformRole: 'admin' | null;
}

export interface ApiKeyContext {
  keyId: string;
  projectId: string;
  environmentId: string;
  environmentKind: 'development' | 'staging' | 'production';
  organizationId: string;
  scopes: ApiKeyScope[];
}

type AuthedRequest = Request & { user?: SessionUser; apiKey?: ApiKeyContext };

/** Validates the Better Auth session cookie server-side on every management request. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!result) throw new ApiError('unauthorized', 'sign in required');
    const u = result.user as typeof result.user & { platformRole?: string | null };
    req.user = {
      id: u.id,
      email: u.email,
      name: u.name,
      platformRole: u.platformRole === 'admin' ? 'admin' : null,
    };
    return true;
  }
}

/** Authenticates `Authorization: Bearer os_...` keys. Independent of user sessions. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const parsed = m ? parseApiKey(m[1]!) : null;
    if (!parsed) throw new ApiError('invalid_api_key', 'missing or malformed API key');
    const rows = await this.db
      .select({
        id: apiKeys.id,
        secretHash: apiKeys.secretHash,
        scopes: apiKeys.scopes,
        projectId: apiKeys.projectId,
        environmentId: apiKeys.environmentId,
        expiresAt: apiKeys.expiresAt,
        environmentKind: environments.kind,
        organizationId: projects.organizationId,
      })
      .from(apiKeys)
      .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row || !safeEqualHex(row.secretHash, sha256Hex(parsed.secret))) {
      throw new ApiError('invalid_api_key', 'invalid API key');
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      throw new ApiError('invalid_api_key', 'API key expired');
    req.apiKey = {
      keyId: row.id,
      projectId: row.projectId,
      environmentId: row.environmentId,
      environmentKind: row.environmentKind,
      organizationId: row.organizationId,
      scopes: row.scopes as ApiKeyScope[],
    };
    // Best-effort usage timestamp, throttled to one write per minute.
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, row.id),
          sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - interval '1 minute')`,
        ),
      )
      .catch(() => undefined);
    return true;
  }
}

export function requireScope(ctx: ApiKeyContext, scope: ApiKeyScope): void {
  if (!ctx.scopes.includes(scope))
    throw new ApiError('insufficient_scope', `API key lacks the "${scope}" scope`);
}

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const u = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!u) throw new ApiError('unauthorized', 'sign in required');
  return u;
});

export const CurrentApiKey = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const k = ctx.switchToHttp().getRequest<AuthedRequest>().apiKey;
  if (!k) throw new ApiError('invalid_api_key', 'API key required');
  return k;
});

export const ClientIp = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Request>().ip ?? null,
);
