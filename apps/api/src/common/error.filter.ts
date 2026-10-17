import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { Logger } from '@opensend/core';
import type { Request, Response } from 'express';
import { LOGGER } from '../infra/tokens';
import { ApiError } from './errors';

const STATUS_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'invalid_request',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'invalid_request',
  422: 'validation_error',
  429: 'rate_limited',
};

/** Renders every error in the documented envelope and never leaks internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = req.id;

    if (exception instanceof ApiError) {
      res.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details !== undefined ? { details: exception.details } : {}),
          requestId,
        },
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      res.status(status).json({
        error: {
          code: STATUS_CODES[status] ?? 'invalid_request',
          message: Array.isArray(message) ? message.join('; ') : message,
          requestId,
        },
      });
      return;
    }
    const err = exception as { type?: string; status?: number };
    if (err?.type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'payload_too_large', message: 'request body too large', requestId },
      });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'invalid_request', message: 'request body is not valid JSON', requestId },
      });
      return;
    }
    this.logger.error({ err: exception, requestId, path: req.path }, 'unhandled error');
    res
      .status(500)
      .json({ error: { code: 'internal_error', message: 'internal server error', requestId } });
  }
}
