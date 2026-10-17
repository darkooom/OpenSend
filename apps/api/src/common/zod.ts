import type { z } from 'zod';
import { ApiError } from './errors';

/** Parse untrusted input; throws a 422 with field-level issues. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ApiError(
      'validation_error',
      'request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
