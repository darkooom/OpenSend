import { z } from 'zod';
import { headerSafeString, paginated } from './common';
import { EMAIL_STATUS, RECIPIENT_STATUS } from './status';

/* -------------------------------------------------------------------------- */
/* Addresses                                                                  */
/* -------------------------------------------------------------------------- */

const addrSpec = z
  .email({ message: 'must be a valid email address' })
  .max(320)
  .transform((v) => v.trim());

/** Accepts `user@example.com`, `Name <user@example.com>` or `{ email, name }`. */
export const mailboxInputSchema = z.union([
  z.string().max(400),
  z.object({ email: z.string().max(320), name: headerSafeString(200).optional() }),
]);
export type MailboxInput = z.infer<typeof mailboxInputSchema>;

export interface Mailbox {
  email: string;
  name?: string;
}

const NAME_ADDR = /^\s*(?:"?([^"<>]*?)"?\s*)<([^<>\s]+)>\s*$/;

/** Parse a mailbox input; returns null when it is not a single valid mailbox. */
export function parseMailbox(input: MailboxInput): Mailbox | null {
  let email: string;
  let name: string | undefined;
  if (typeof input === 'string') {
    if (/[\r\n\u0000-\u001f]/.test(input)) return null;
    const m = NAME_ADDR.exec(input);
    if (m) {
      email = m[2] ?? '';
      name = m[1]?.trim() || undefined;
    } else {
      email = input.trim();
    }
  } else {
    email = input.email.trim();
    name = input.name?.trim() || undefined;
  }
  const parsed = addrSpec.safeParse(email);
  if (!parsed.success) return null;
  // Domain part is case-insensitive; normalize it. Local part is preserved.
  const at = parsed.data.lastIndexOf('@');
  const normalized = parsed.data.slice(0, at) + '@' + parsed.data.slice(at + 1).toLowerCase();
  if (name !== undefined && (/[\r\n]/.test(name) || name.length > 200)) return null;
  return name ? { email: normalized, name } : { email: normalized };
}

const recipientList = z
  .union([mailboxInputSchema, z.array(mailboxInputSchema).max(1000)])
  .optional();

/* -------------------------------------------------------------------------- */
/* Custom headers                                                              */
/* -------------------------------------------------------------------------- */

/** Headers a client may never set: identity, routing, MIME structure, authentication, internal. */
export const FORBIDDEN_HEADER_PATTERNS: RegExp[] = [
  /^(from|to|cc|bcc|sender|reply-to|subject|date|message-id|return-path|received|mime-version)$/i,
  /^content-/i,
  /^(dkim-signature|domainkey-signature|authentication-results|arc-.*|received-spf)$/i,
  /^x-opensend-/i,
  /^x-ses-/i,
  /^(x-mailer|x-originating-ip|bounces-to|errors-to|disposition-notification-to)$/i,
];
export const ALLOWED_STANDARD_HEADERS = [
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'in-reply-to',
  'references',
  'precedence',
  'auto-submitted',
  'x-entity-ref-id',
];

export function isAllowedCustomHeader(name: string): boolean {
  if (!/^[A-Za-z0-9-]{1,76}$/.test(name)) return false;
  if (FORBIDDEN_HEADER_PATTERNS.some((p) => p.test(name))) return false;
  return (
    name.toLowerCase().startsWith('x-') || ALLOWED_STANDARD_HEADERS.includes(name.toLowerCase())
  );
}

export const headersSchema = z
  .record(z.string(), headerSafeString(998))
  .superRefine((headers, ctx) => {
    const keys = Object.keys(headers);
    if (keys.length > 30) ctx.addIssue({ code: 'custom', message: 'at most 30 custom headers' });
    for (const k of keys) {
      if (!isAllowedCustomHeader(k)) {
        ctx.addIssue({ code: 'custom', path: [k], message: `header "${k}" is not allowed` });
      }
    }
  });

/* -------------------------------------------------------------------------- */
/* Send request                                                                */
/* -------------------------------------------------------------------------- */

export const tagsSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'tag names: letters, digits, _ and -'),
    z.string().max(256),
  )
  .refine((t) => Object.keys(t).length <= 10, { message: 'at most 10 tags' });

export const attachmentInputSchema = z.object({
  filename: headerSafeString(255)
    .min(1)
    .refine((v) => !/[\\/]/.test(v), { message: 'must not contain path separators' }),
  /** Base64 encoded file content. External URLs are intentionally not supported. */
  content: z.string().min(1),
  contentType: z
    .string()
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i, 'invalid MIME type')
    .max(127)
    .optional(),
  /** Set for inline images referenced as `cid:<contentId>`. */
  contentId: z
    .string()
    .regex(/^[A-Za-z0-9._@-]{1,100}$/)
    .optional(),
});

export const templateRefSchema = z.object({
  /** Template id or slug within the API key's environment. */
  id: z.string().min(1).max(100),
  /** Published version; defaults to the latest published version. */
  version: z.number().int().positive().optional(),
  variables: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
});

export const sendEmailRequestSchema = z
  .object({
    from: mailboxInputSchema,
    to: recipientList,
    cc: recipientList,
    bcc: recipientList,
    replyTo: recipientList,
    subject: headerSafeString(998).optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    template: templateRefSchema.optional(),
    headers: headersSchema.optional(),
    tags: tagsSchema.optional(),
    attachments: z.array(attachmentInputSchema).optional(),
    /** ISO 8601 timestamp; the email is not handed to the provider before this time. */
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.template) {
      if (v.html !== undefined || v.text !== undefined || v.subject !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['template'],
          message: 'use either template or subject/html/text',
        });
      }
    } else {
      if (!v.subject)
        ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is required' });
      if (!v.html && !v.text)
        ctx.addIssue({ code: 'custom', path: ['html'], message: 'html or text is required' });
    }
  });
export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

export const batchSendRequestSchema = z.object({
  emails: z.array(z.unknown()).min(1),
});

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

export const acceptedEmailResponseSchema = z.object({
  id: z.uuid(),
  object: z.literal('email'),
  status: z.enum(EMAIL_STATUS),
  scheduledAt: z.string().nullable(),
});
export type AcceptedEmailResponse = z.infer<typeof acceptedEmailResponseSchema>;

export const recipientResourceSchema = z.object({
  address: z.string(),
  kind: z.enum(['to', 'cc', 'bcc']),
  status: z.enum(RECIPIENT_STATUS),
  statusDetail: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  bouncedAt: z.string().nullable(),
  bounceType: z.string().nullable(),
  complainedAt: z.string().nullable(),
  deferredAt: z.string().nullable(),
});

export const recipientSummarySchema = z.object({
  total: z.number(),
  pending: z.number(),
  suppressed: z.number(),
  submitted: z.number(),
  rejected: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  unknown: z.number(),
  delivered: z.number(),
  bounced: z.number(),
  complained: z.number(),
});

export const emailResourceSchema = z.object({
  id: z.uuid(),
  object: z.literal('email'),
  status: z.enum(EMAIL_STATUS),
  displayStatus: z.string(),
  from: z.string(),
  subject: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
  scheduledAt: z.string().nullable(),
  createdAt: z.string(),
  submittedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  attempts: z.number(),
  lastError: z
    .object({
      category: z.string().nullable(),
      code: z.string().nullable(),
      message: z.string().nullable(),
    })
    .nullable(),
  recipients: z.array(recipientResourceSchema),
  summary: recipientSummarySchema,
  templateId: z.string().nullable(),
  templateVersionId: z.string().nullable(),
  batchId: z.string().nullable(),
  resendOf: z.string().nullable(),
  contentPurged: z.boolean(),
});
export type EmailResource = z.infer<typeof emailResourceSchema>;

export const emailListItemSchema = emailResourceSchema.omit({ recipients: true });
export type EmailListItem = z.infer<typeof emailListItemSchema>;
export const emailListResponseSchema = paginated(emailListItemSchema);

export const emailListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  status: z.enum(EMAIL_STATUS).optional(),
  /** Exact (case-insensitive) recipient address. */
  recipient: z.string().max(320).optional(),
  /** Tag filter `name:value`. */
  tag: z.string().max(330).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type EmailListQuery = z.infer<typeof emailListQuerySchema>;

export const batchResponseSchema = z.object({
  object: z.literal('batch'),
  id: z.uuid(),
  data: z.array(z.object({ index: z.number(), id: z.uuid(), status: z.enum(EMAIL_STATUS) })),
  errors: z.array(
    z.object({
      index: z.number(),
      error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
    }),
  ),
});
export type BatchResponse = z.infer<typeof batchResponseSchema>;
