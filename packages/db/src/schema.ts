/**
 * OpenSend database schema (PostgreSQL, Drizzle ORM, snake_case columns).
 *
 * Tenancy: organization -> project -> environment. Every tenant-owned row carries
 * `project_id` (and `environment_id` where it applies) so that authorization filters
 * can be expressed directly in queries without joins through untrusted input.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });

/* -------------------------------------------------------------------------- */
/* Better Auth core tables (users, sessions, credential accounts, tokens).     */
/* -------------------------------------------------------------------------- */

export const user = pgTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  /** Platform operator role. `admin` may pause projects / connections platform-wide. */
  platformRole: text({ enum: ['admin'] }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index().on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: ts(),
    refreshTokenExpiresAt: ts(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.identifier)],
);

/* -------------------------------------------------------------------------- */
/* Installation state / bootstrap                                             */
/* -------------------------------------------------------------------------- */

export const systemState = pgTable('system_state', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
});

export const bootstrapTokens = pgTable('bootstrap_tokens', {
  id: id(),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: ts(),
  createdAt: createdAt(),
});

/* -------------------------------------------------------------------------- */
/* Organizations, memberships, invitations                                     */
/* -------------------------------------------------------------------------- */

export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const organizations = pgTable('organizations', {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text({ enum: ROLES }).notNull(),
    /** `all`: every project in the organization; `selected`: only rows in membership_projects. */
    projectAccess: text({ enum: ['all', 'selected'] })
      .notNull()
      .default('all'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.organizationId, t.userId), index().on(t.userId)],
);

export const membershipProjects = pgTable(
  'membership_projects',
  {
    membershipId: uuid()
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.projectId] })],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text({ enum: ROLES }).notNull(),
    projectAccess: text({ enum: ['all', 'selected'] })
      .notNull()
      .default('all'),
    projectIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    tokenHash: text().notNull().unique(),
    invitedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.organizationId)],
);

/* -------------------------------------------------------------------------- */
/* Projects and environments                                                   */
/* -------------------------------------------------------------------------- */

export const projects = pgTable(
  'projects',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    slug: text().notNull(),
    /** Days to keep rendered content after the send job reached a final state. 0 = purge right away. */
    contentRetentionDays: integer().notNull().default(0),
    attachmentRetentionDays: integer().notNull().default(0),
    /** Days to keep email metadata, recipients and event history. */
    eventRetentionDays: integer().notNull().default(90),
    /** Monthly recipient quota; null means the instance default. */
    monthlyRecipientQuota: integer(),
    /** Set by a platform operator. A paused project cannot accept or submit email. */
    pausedAt: ts(),
    pausedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex().on(t.organizationId, t.slug),
    check(
      'projects_retention_nonneg',
      sql`${t.contentRetentionDays} >= 0 AND ${t.attachmentRetentionDays} >= 0 AND ${t.eventRetentionDays} >= 1`,
    ),
  ],
);

export const ENVIRONMENT_KINDS = ['development', 'staging', 'production'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const environments = pgTable(
  'environments',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    kind: text({ enum: ENVIRONMENT_KINDS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.name)],
);

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Public, non-secret identifier embedded in the key (`os_<prefix>_<secret>`). */
    prefix: text().notNull().unique(),
    /** SHA-256 of the secret part (high-entropy random value). */
    secretHash: text().notNull(),
    scopes: text().array().notNull(),
    createdByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: ts(),
    revokedAt: ts(),
    lastUsedAt: ts(),
  },
  (t) => [index().on(t.projectId, t.environmentId)],
);

/* -------------------------------------------------------------------------- */
/* Provider connections and domains                                           */
/* -------------------------------------------------------------------------- */

export const PROVIDER_TYPES = ['local', 'smtp', 'ses'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    type: text({ enum: PROVIDER_TYPES }).notNull(),
    /** Non-secret settings (host, port, region, topic ARN, ...). */
    config: jsonb().notNull().default({}),
    /** Encrypted JSON with credentials (AES-256-GCM envelope, see crypto docs). */
    secretCiphertext: text(),
    isDefault: boolean().notNull().default(false),
    enabled: boolean().notNull().default(true),
    /** Platform-operator pause, separate from the tenant's own `enabled` flag. */
    pausedAt: ts(),
    pausedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.projectId, t.environmentId),
    uniqueIndex('provider_connections_one_default')
      .on(t.environmentId)
      .where(sql`${t.isDefault} = true`),
  ],
);

export const domains = pgTable(
  'domains',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /** Lower-case ASCII (punycode) name without trailing dot. */
    name: text().notNull(),
    /** Reserved test domains (e.g. *.test). Usable only with the local provider outside production. */
    localOnly: boolean().notNull().default(false),
    ownershipToken: text().notNull(),
    ownershipVerifiedAt: ts(),
    ownershipCheckedAt: ts(),
    ownershipLastError: text(),
    providerConnectionId: uuid().references(() => providerConnections.id, { onDelete: 'set null' }),
    providerStatus: text({
      enum: ['not_started', 'pending', 'verified', 'failed', 'not_required', 'unsupported'],
    })
      .notNull()
      .default('not_started'),
    /** DNS records the provider adapter requires (as reported by that adapter). */
    providerRecords: jsonb().notNull().default([]),
    providerCheckedAt: ts(),
    providerLastError: text(),
    /** Latest DNS diagnostics (SPF / DMARC / expected vs. found). */
    dnsDiagnostics: jsonb(),
    dnsCheckedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.environmentId, t.name), index().on(t.name)],
);

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

export const templates = pgTable(
  'templates',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    slug: text().notNull(),
    draftSubject: text().notNull().default(''),
    draftHtml: text(),
    draftText: text(),
    draftVariables: jsonb().notNull().default([]),
    latestVersion: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.environmentId, t.slug)],
);

/** Immutable published versions. Emails reference a version and persist their rendered output. */
export const templateVersions = pgTable(
  'template_versions',
  {
    id: id(),
    templateId: uuid()
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(),
    version: integer().notNull(),
    subject: text().notNull(),
    html: text(),
    text: text(),
    variables: jsonb().notNull(),
    publishedByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    publishedAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.templateId, t.version)],
);

/* -------------------------------------------------------------------------- */
/* Emails (send jobs)                                                          */
/* -------------------------------------------------------------------------- */

export const EMAIL_STATUSES = [
  'accepted',
  'scheduled',
  'queued',
  'submitting',
  'retry_wait',
  'submitted',
  'failed',
  'submission_unknown',
  'cancelled',
  'suppressed',
] as const;
export type EmailStatusDb = (typeof EMAIL_STATUSES)[number];

export const emails = pgTable(
  'emails',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: 'set null' }),
    createdByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    status: text({ enum: EMAIL_STATUSES }).notNull(),
    fromAddress: text().notNull(),
    fromName: text(),
    /** Cleared together with the content when the content retention expires. */
    subject: text(),
    tags: jsonb().notNull().default({}),
    templateId: uuid().references(() => templates.id, { onDelete: 'set null' }),
    templateVersionId: uuid().references(() => templateVersions.id, { onDelete: 'set null' }),
    scheduledAt: ts(),
    providerConnectionId: uuid().references(() => providerConnections.id, { onDelete: 'set null' }),
    providerMessageId: text(),
    /** RFC 5322 Message-ID we generate; used for correlation and provider status lookups. */
    messageIdHeader: text().notNull(),
    recipientCount: integer().notNull(),
    attemptCount: integer().notNull().default(0),
    nextAttemptAt: ts(),
    leaseOwner: text(),
    leaseExpiresAt: ts(),
    failureCategory: text(),
    lastErrorCode: text(),
    lastErrorMessage: text(),
    batchId: uuid(),
    resendOfEmailId: uuid(),
    acceptedAt: createdAt(),
    submittedAt: ts(),
    finalizedAt: ts(),
    cancelledAt: ts(),
    contentPurgedAt: ts(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.environmentId, t.acceptedAt.desc()),
    index().on(t.projectId, t.acceptedAt.desc()),
    index().on(t.projectId, t.status),
    index().on(t.providerMessageId),
    index('emails_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'submitting'`),
  ],
);

/** Encrypted rendered message (html, text, headers, reply-to). Deleted by the retention job. */
export const emailContents = pgTable('email_contents', {
  emailId: uuid()
    .primaryKey()
    .references(() => emails.id, { onDelete: 'cascade' }),
  projectId: uuid().notNull(),
  ciphertext: text().notNull(),
  createdAt: createdAt(),
});

export const RECIPIENT_STATUSES = [
  'pending',
  'suppressed',
  'submitted',
  'rejected',
  'failed',
  'cancelled',
  'unknown',
] as const;

export const emailRecipients = pgTable(
  'email_recipients',
  {
    id: id(),
    emailId: uuid()
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(),
    environmentId: uuid().notNull(),
    address: text().notNull(),
    kind: text({ enum: ['to', 'cc', 'bcc'] }).notNull(),
    /** Submission-side state for this recipient. */
    status: text({ enum: RECIPIENT_STATUSES }).notNull().default('pending'),
    statusDetail: text(),
    /** Delivery-side facts derived from trusted provider events; each is kept independently. */
    deliveredAt: ts(),
    bouncedAt: ts(),
    bounceType: text(),
    complainedAt: ts(),
    deferredAt: ts(),
    lastEventAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.emailId), index().on(t.environmentId, t.address)],
);

export const emailAttachments = pgTable(
  'email_attachments',
  {
    id: id(),
    emailId: uuid()
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(),
    /** Server-generated key: `projects/<projectId>/emails/<emailId>/<attachmentId>`. Never client supplied. */
    objectKey: text().notNull().unique(),
    filename: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: integer().notNull(),
    contentId: text(),
    purgedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.emailId)],
);

export const sendAttempts = pgTable(
  'send_attempts',
  {
    id: id(),
    emailId: uuid()
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(),
    attemptNumber: integer().notNull(),
    providerConnectionId: uuid(),
    workerId: text(),
    outcome: text({
      enum: ['started', 'accepted', 'transient_failure', 'permanent_failure', 'unknown'],
    })
      .notNull()
      .default('started'),
    errorCategory: text(),
    errorCode: text(),
    errorMessage: text(),
    providerMessageId: text(),
    providerResponse: text(),
    startedAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [uniqueIndex().on(t.emailId, t.attemptNumber)],
);

/** Append-only lifecycle history for emails and recipients. */
export const emailEvents = pgTable(
  'email_events',
  {
    id: id(),
    emailId: uuid()
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    recipientId: uuid().references(() => emailRecipients.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(),
    environmentId: uuid().notNull(),
    type: text().notNull(),
    source: text({ enum: ['system', 'provider', 'user', 'operator'] }).notNull(),
    providerEventId: uuid(),
    data: jsonb().notNull().default({}),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    recordedAt: createdAt(),
  },
  (t) => [
    index().on(t.emailId, t.occurredAt),
    index().on(t.projectId, t.recordedAt),
    // One provider event never produces the same lifecycle entry twice for a recipient.
    uniqueIndex('email_events_provider_dedupe')
      .on(t.providerEventId, t.recipientId, t.type)
      .where(sql`${t.providerEventId} IS NOT NULL`),
  ],
);

/** Raw inbound provider notifications. Kept even when they cannot (yet) be matched to an email. */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: id(),
    provider: text({ enum: PROVIDER_TYPES }).notNull(),
    providerConnectionId: uuid().references(() => providerConnections.id, { onDelete: 'set null' }),
    /** Provider-side unique id used for deduplication (e.g. SNS MessageId). */
    externalId: text().notNull(),
    providerMessageId: text(),
    eventType: text().notNull(),
    occurredAt: ts(),
    payload: jsonb().notNull(),
    matchStatus: text({ enum: ['pending', 'matched', 'unmatched', 'ignored'] })
      .notNull()
      .default('pending'),
    matchAttempts: integer().notNull().default(0),
    projectId: uuid(),
    emailId: uuid(),
    receivedAt: createdAt(),
    processedAt: ts(),
  },
  (t) => [
    uniqueIndex().on(t.provider, t.externalId),
    index().on(t.matchStatus, t.receivedAt),
    index().on(t.providerMessageId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Transactional outbox                                                        */
/* -------------------------------------------------------------------------- */

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    kind: text({ enum: ['send_email', 'deliver_webhook', 'process_provider_event'] }).notNull(),
    refId: uuid().notNull(),
    projectId: uuid().notNull(),
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: ts(),
    dispatchCount: integer().notNull().default(0),
    completedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.completedAt} IS NULL`),
    index().on(t.kind, t.refId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                 */
/* -------------------------------------------------------------------------- */

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    projectId: uuid().notNull(),
    environmentId: uuid().notNull(),
    operation: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    emailId: uuid(),
    responseStatus: integer().notNull(),
    responseBody: jsonb().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex().on(t.projectId, t.environmentId, t.operation, t.key),
    index().on(t.expiresAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Suppressions                                                                */
/* -------------------------------------------------------------------------- */

export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    address: text().notNull(),
    reason: text({ enum: ['hard_bounce', 'complaint', 'manual'] }).notNull(),
    sourceEmailId: uuid(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.environmentId, t.address)],
);

/** Operator-managed, instance-wide block list. Tenants only learn "blocked by platform policy". */
export const platformSuppressions = pgTable('platform_suppressions', {
  id: id(),
  address: text().notNull().unique(),
  reason: text().notNull(),
  createdByUserId: text().references(() => user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/* -------------------------------------------------------------------------- */
/* Usage and quotas                                                            */
/* -------------------------------------------------------------------------- */

export const usagePeriods = pgTable(
  'usage_periods',
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    period: date({ mode: 'string' }).notNull(),
    acceptedEmails: integer().notNull().default(0),
    acceptedRecipients: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.period] })],
);

/** One row per counted fact; the unique index makes counting idempotent. */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: id(),
    projectId: uuid().notNull(),
    environmentId: uuid().notNull(),
    period: date({ mode: 'string' }).notNull(),
    emailId: uuid().notNull(),
    kind: text().notNull(),
    quantity: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.emailId, t.kind), index().on(t.projectId, t.period)],
);

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    description: text(),
    eventTypes: text().array().notNull(),
    secretCiphertext: text().notNull(),
    previousSecretCiphertext: text(),
    previousSecretExpiresAt: ts(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.projectId, t.environmentId)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    projectId: uuid().notNull(),
    environmentId: uuid().notNull(),
    type: text().notNull(),
    version: integer().notNull().default(1),
    emailId: uuid(),
    payload: jsonb().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.projectId, t.createdAt)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookEventId: uuid()
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    endpointId: uuid()
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(),
    status: text({ enum: ['pending', 'succeeded', 'retry_wait', 'dead'] })
      .notNull()
      .default('pending'),
    kind: text({ enum: ['event', 'replay', 'test'] })
      .notNull()
      .default('event'),
    attemptCount: integer().notNull().default(0),
    nextAttemptAt: ts(),
    lastStatusCode: integer(),
    lastError: text(),
    lastAttemptAt: ts(),
    completedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.endpointId, t.createdAt), index().on(t.projectId, t.status)],
);

export const webhookDeliveryAttempts = pgTable(
  'webhook_delivery_attempts',
  {
    id: id(),
    deliveryId: uuid()
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: 'cascade' }),
    attemptNumber: integer().notNull(),
    statusCode: integer(),
    error: text(),
    durationMs: integer(),
    startedAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.deliveryId, t.attemptNumber)],
);

/* -------------------------------------------------------------------------- */
/* Audit log                                                                   */
/* -------------------------------------------------------------------------- */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    organizationId: uuid(),
    projectId: uuid(),
    actorType: text({ enum: ['user', 'api_key', 'system', 'platform_admin'] }).notNull(),
    actorId: text(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    metadata: jsonb().notNull().default({}),
    ipAddress: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.organizationId, t.createdAt), index().on(t.projectId, t.createdAt)],
);
