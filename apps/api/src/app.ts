import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '@opensend/config';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module';

export { setSnsCertFetcher } from './app.module';
import type { Auth } from './auth/auth';
import { originCheckMiddleware, requestIdMiddleware } from './common/request-context';
import { configureInfra, type InfraOverrides } from './infra/infra.module';
import { AUTH, LOGGER } from './infra/tokens';
import type { Logger } from '@opensend/core';

/** Builds the HTTP application (used by main.ts and the integration tests). */
export async function createApp(overrides: InfraOverrides): Promise<NestExpressApplication> {
  configureInfra(overrides);
  const config: AppConfig = overrides.config;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  const logger = app.get<Logger>(LOGGER);
  const auth = app.get<Auth>(AUTH);
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { id?: string }).id ?? '',
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      // Never log bodies; URLs only contain ids.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
    }),
  );
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // Cookie-authenticated management API: same-origin requests only (CSRF).
  app.use('/api', originCheckMiddleware(config.PUBLIC_WEB_URL));
  // Better Auth owns /api/auth/* and needs the raw request stream.
  // (better-call re-joins req.baseUrl + req.url itself, so the mount path is preserved.)
  const authHandler = toNodeHandler(auth);
  app.use('/api/auth', (req: express.Request, res: express.Response) => void authHandler(req, res));
  // SNS posts JSON with Content-Type text/plain.
  app.use('/webhooks/ses', express.text({ type: '*/*', limit: '256kb' }));
  app.use(express.json({ limit: config.OPENSEND_MAX_REQUEST_BYTES }));
  await app.init();
  return app;
}
