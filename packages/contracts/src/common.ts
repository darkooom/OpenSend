import { z } from 'zod';

export const uuidSchema = z.uuid();

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    object: z.literal('list'),
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/** Rejects CR/LF and other control characters (header injection guard). */
export const headerSafeString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), {
      message: 'must not contain line breaks or control characters',
    });
