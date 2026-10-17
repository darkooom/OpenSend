import { z } from 'zod';

export const createDomainRequestSchema = z.object({
  name: z.string().min(1).max(253),
  /** Provider connection whose DNS requirements apply. Defaults to the environment's default connection. */
  providerConnectionId: z.uuid().optional(),
});

export const dnsRecordSchema = z.object({
  purpose: z.enum(['ownership', 'dkim', 'spf', 'dmarc', 'mail_from', 'other']),
  type: z.enum(['TXT', 'CNAME', 'MX']),
  name: z.string(),
  value: z.string(),
  priority: z.number().optional(),
  required: z.boolean(),
  /** Result of the most recent DNS lookup for this record. */
  status: z.enum(['unknown', 'found', 'missing', 'mismatch']).default('unknown'),
  found: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

export const domainResourceSchema = z.object({
  id: z.uuid(),
  object: z.literal('domain'),
  name: z.string(),
  localOnly: z.boolean(),
  ownership: z.object({
    status: z.enum(['pending', 'verified']),
    record: dnsRecordSchema,
    checkedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
  provider: z.object({
    connectionId: z.string().nullable(),
    type: z.string().nullable(),
    status: z.enum(['not_started', 'pending', 'verified', 'failed', 'not_required', 'unsupported']),
    records: z.array(dnsRecordSchema),
    checkedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
  diagnostics: z
    .object({
      checkedAt: z.string(),
      spf: z.object({ status: z.string(), records: z.array(z.string()), message: z.string() }),
      dmarc: z.object({ status: z.string(), records: z.array(z.string()), message: z.string() }),
    })
    .nullable(),
  canSend: z.boolean(),
  createdAt: z.string(),
});
export type DomainResource = z.infer<typeof domainResourceSchema>;
