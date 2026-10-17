import { HttpException } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@opensend/contracts';

/** Application error with a stable code; rendered as `{ error: { code, message, details } }`. */
export class ApiError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, ERROR_CODES[code]);
  }
}

export const notFound = (what = 'resource') => new ApiError('not_found', `${what} not found`);
export const forbidden = (msg = 'you do not have permission for this action') =>
  new ApiError('forbidden', msg);
