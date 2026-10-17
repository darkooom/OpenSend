import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Correlation id: accept a sane incoming X-Request-Id, otherwise generate one. */
export function requestIdMiddleware(
  req: Request & { id?: string },
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9._-]{8,100}$/.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}

/**
 * CSRF defence for cookie-authenticated management routes: state-changing requests must
 * originate from the dashboard origin. API-key routes (/v1) do not use cookies and are exempt.
 */
export function originCheckMiddleware(allowedOrigin: string) {
  const allowed = new URL(allowedOrigin).origin;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.header('origin');
    const site = req.header('sec-fetch-site');
    if (origin ? origin === allowed : site === 'same-origin') return next();
    res.status(403).json({ error: { code: 'forbidden', message: 'cross-site request rejected' } });
  };
}
