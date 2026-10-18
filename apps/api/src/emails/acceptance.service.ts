import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import {
  FINAL_STATUSES,
  PENDING_STATUSES,
  parseMailbox,
  sendEmailRequestSchema,
  type AcceptedEmailResponse,
  type MailboxInput,
  type SendEmailRequest,
} from '@opensend/contracts';
import {
  KeyRing,
  QuotaExceededError,
  TemplateError,
  attachmentObjectKey,
  canonicalJson,
  domainOfAddress,
  enqueueOutbox,
  findSuppressed,
  putEncrypted,
  recordEmailEvent,
  renderTemplate,
  reserveRecipientQuota,
  resolveValues,
  sha256Hex,
  uuidv7,
  type ObjectStore,
  type TemplateVariable,
} from '@opensend/core';
import {
  and,
  domains,
  emailAttachments,
  emailContents,
  emailRecipients,
  emails,
  environments,
  eq,
  idempotencyKeys,
  inArray,
  projects,
  providerConnections,
  sql,
  templateVersions,
  templates,
  type Database,
  type Tx,
} from '@opensend/db';
import { PROVIDER_CAPABILITIES } from '@opensend/providers';
import { ApiError } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { CONFIG, DB, KEYRING, OBJECT_STORE } from '../infra/tokens';

export interface SendContext {
  projectId: string;
  environmentId: string;
  apiKeyId?: string;
  userId?: string;
  batchId?: string;
  resendOfEmailId?: string;
}

export interface AcceptResult {
  status: number;
  body: AcceptedEmailResponse;
  replayed: boolean;
}

interface PreparedRecipient {
  address: string;
  kind: 'to' | 'cc' | 'bcc';
}

interface PreparedAttachment {
  id: string;
  filename: string;
  contentType: string;
  contentId?: string;
  content: Buffer;
  objectKey: string;
}

/** Stored (encrypted) part of a send job. Nothing here is written in clear text. */
export interface StoredContent {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  replyTo: string[];
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

class IdempotentReplay extends Error {
  constructor(readonly result: AcceptResult) {
    super('idempotent replay');
  }
}

@Injectable()
export class AcceptanceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KEYRING) private readonly keys: KeyRing,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /**
   * Durably accept one email. On success the job, its recipients, encrypted content,
   * usage reservation, idempotency record, lifecycle events and outbox entry are all
   * committed in ONE transaction; 202 therefore means "durably accepted", not "delivered".
   */
  async accept(
    ctx: SendContext,
    rawInput: unknown,
    idempotencyKey?: string,
    operation = 'emails.send',
  ): Promise<AcceptResult> {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new ApiError(
        'invalid_request',
        'Idempotency-Key must be 1-255 printable ASCII characters',
      );
    }
    const input = parseOrThrow(sendEmailRequestSchema, rawInput);
    const requestHash = sha256Hex(`${operation}\n${canonicalJson(input)}`);

    // Cheap pre-check so a replay does not upload attachments again. The authoritative
    // check is the unique constraint inside the transaction below.
    if (idempotencyKey) {
      const existing = await this.findIdempotent(this.db, ctx, operation, idempotencyKey);
      if (existing) return this.replay(existing, requestHash);
    }

    const prepared = this.prepare(input);
    const emailId = uuidv7();
    const attachments = this.prepareAttachments(input, ctx.projectId, emailId);

    const uploaded: string[] = [];
    try {
      for (const a of attachments) {
        await putEncrypted(this.store, this.keys, a.objectKey, a.content);
        uploaded.push(a.objectKey);
      }
      const result = await this.db.transaction(async (tx) =>
        this.acceptInTx(
          tx,
          ctx,
          input,
          prepared,
          attachments,
          emailId,
          requestHash,
          operation,
          idempotencyKey,
        ),
      );
      return result;
    } catch (err) {
      await Promise.all(uploaded.map((k) => this.store.delete(k).catch(() => undefined)));
      if (err instanceof IdempotentReplay) return err.result;
      if (err instanceof QuotaExceededError) {
        throw new ApiError('quota_exceeded', 'monthly recipient quota exceeded', {
          limit: err.limit,
          used: err.used,
        });
      }
      if (err instanceof TemplateError)
        throw new ApiError('validation_error', err.message, err.details);
      throw err;
    }
  }

  private prepare(input: SendEmailRequest) {
    const from = parseMailbox(input.from);
    if (!from)
      throw new ApiError('validation_error', 'invalid from address', [
        { path: 'from', message: 'must be a single valid mailbox' },
      ]);

    const seen = new Set<string>();
    const recipients: PreparedRecipient[] = [];
    const collect = (
      value: MailboxInput | MailboxInput[] | undefined,
      kind: PreparedRecipient['kind'],
    ) => {
      const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
      list.forEach((entry, i) => {
        const mb = parseMailbox(entry);
        if (!mb)
          throw new ApiError('validation_error', `invalid ${kind} address`, [
            { path: `${kind}.${i}`, message: 'invalid email address' },
          ]);
        const key = mb.email.toLowerCase();
        if (seen.has(key)) return; // the same mailbox only receives one copy
        seen.add(key);
        recipients.push({ address: mb.email, kind });
      });
    };
    collect(input.to, 'to');
    collect(input.cc, 'cc');
    collect(input.bcc, 'bcc');
    if (recipients.length === 0)
      throw new ApiError('validation_error', 'at least one recipient (to, cc or bcc) is required');
    if (recipients.length > this.config.OPENSEND_MAX_RECIPIENTS) {
      throw new ApiError(
        'validation_error',
        `at most ${this.config.OPENSEND_MAX_RECIPIENTS} recipients per email`,
        {
          limit: this.config.OPENSEND_MAX_RECIPIENTS,
        },
      );
    }
    const replyTo = (
      input.replyTo === undefined
        ? []
        : Array.isArray(input.replyTo)
          ? input.replyTo
          : [input.replyTo]
    ).map((r, i) => {
      const mb = parseMailbox(r);
      if (!mb)
        throw new ApiError('validation_error', 'invalid replyTo address', [
          { path: `replyTo.${i}`, message: 'invalid email address' },
        ]);
      return mb.email;
    });

    let scheduledAt: Date | null = null;
    if (input.scheduledAt) {
      scheduledAt = new Date(input.scheduledAt);
      const now = Date.now();
      if (scheduledAt.getTime() < now - 5 * 60_000) {
        throw new ApiError('validation_error', 'scheduledAt is in the past', [
          { path: 'scheduledAt', message: 'must not be in the past' },
        ]);
      }
      if (scheduledAt.getTime() > now + this.config.OPENSEND_MAX_SCHEDULE_DAYS * 86_400_000) {
        throw new ApiError(
          'validation_error',
          `scheduledAt is more than ${this.config.OPENSEND_MAX_SCHEDULE_DAYS} days ahead`,
        );
      }
      if (scheduledAt.getTime() <= now) scheduledAt = null; // effectively immediate
    }

    const bodyBytes = Buffer.byteLength(input.html ?? '') + Buffer.byteLength(input.text ?? '');
    if (bodyBytes > this.config.OPENSEND_MAX_BODY_BYTES) {
      throw new ApiError('payload_too_large', 'message body too large', {
        limit: this.config.OPENSEND_MAX_BODY_BYTES,
      });
    }
    return { from, recipients, replyTo, scheduledAt };
  }

  private prepareAttachments(
    input: SendEmailRequest,
    projectId: string,
    emailId: string,
  ): PreparedAttachment[] {
    const list = input.attachments ?? [];
    if (list.length > this.config.OPENSEND_MAX_ATTACHMENTS) {
      throw new ApiError(
        'validation_error',
        `at most ${this.config.OPENSEND_MAX_ATTACHMENTS} attachments`,
      );
    }
    let total = 0;
    return list.map((a, i) => {
      if (!BASE64.test(a.content) || a.content.length % 4 !== 0) {
        throw new ApiError('validation_error', 'attachment content must be base64', [
          { path: `attachments.${i}.content`, message: 'invalid base64' },
        ]);
      }
      const content = Buffer.from(a.content, 'base64');
      total += content.length;
      if (total > this.config.OPENSEND_MAX_ATTACHMENT_BYTES) {
        throw new ApiError('payload_too_large', 'attachments too large', {
          limit: this.config.OPENSEND_MAX_ATTACHMENT_BYTES,
        });
      }
      const id = uuidv7();
      return {
        id,
        filename: a.filename,
        contentType: a.contentType ?? 'application/octet-stream',
        contentId: a.contentId,
        content,
        objectKey: attachmentObjectKey(projectId, emailId, id),
      };
    });
  }

  private async acceptInTx(
    tx: Tx,
    ctx: SendContext,
    input: SendEmailRequest,
    prepared: ReturnType<AcceptanceService['prepare']>,
    attachments: PreparedAttachment[],
    emailId: string,
    requestHash: string,
    operation: string,
    idempotencyKey?: string,
  ): Promise<AcceptResult> {
    const [row] = await tx
      .select({ project: projects, environment: environments })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(eq(environments.id, ctx.environmentId), eq(projects.id, ctx.projectId)))
      .limit(1);
    if (!row) throw new ApiError('not_found', 'environment not found');
    const { project, environment } = row;
    if (project.pausedAt)
      throw new ApiError(
        'project_paused',
        'sending is paused for this project by the platform operator',
      );

    // --- idempotency: authoritative claim via unique constraint -----------------------
    if (idempotencyKey) {
      await tx.execute(sql`
        DELETE FROM idempotency_keys
         WHERE project_id = ${ctx.projectId} AND environment_id = ${ctx.environmentId}
           AND operation = ${operation} AND key = ${idempotencyKey}
           AND expires_at < now()
           AND (email_id IS NULL OR email_id IN (SELECT id FROM emails WHERE status IN (${sql.join(
             FINAL_STATUSES.map((s) => sql`${s}`),
             sql`, `,
           )})))`);
      const ttlMs = this.config.OPENSEND_IDEMPOTENCY_TTL_HOURS * 3_600_000;
      const base = Math.max(Date.now(), prepared.scheduledAt?.getTime() ?? 0);
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          operation,
          key: idempotencyKey,
          requestHash,
          emailId,
          responseStatus: 202,
          responseBody: {},
          expiresAt: new Date(base + ttlMs),
        })
        .onConflictDoNothing()
        .returning({ id: idempotencyKeys.id });
      if (claimed.length === 0) {
        // A concurrent request with the same key committed first (we waited on its lock).
        const existing = await this.findIdempotent(tx, ctx, operation, idempotencyKey);
        if (!existing)
          throw new ApiError(
            'idempotency_in_progress',
            'a request with this Idempotency-Key is still in progress',
          );
        throw new IdempotentReplay(this.replay(existing, requestHash));
      }
    }

    // --- content (template or inline) --------------------------------------------------
    let subject: string;
    let html: string | null;
    let text: string | null;
    let templateId: string | null = null;
    let templateVersionId: string | null = null;
    if (input.template) {
      const t = await this.resolveTemplate(
        tx,
        ctx.environmentId,
        input.template.id,
        input.template.version,
      );
      const values = resolveValues(
        t.version.variables as TemplateVariable[],
        input.template.variables,
        'send',
      );
      const rendered = renderTemplate(
        { subject: t.version.subject, html: t.version.html, text: t.version.text },
        values,
        {
          maxSubjectBytes: this.config.OPENSEND_MAX_SUBJECT_LENGTH,
          maxBodyBytes: this.config.OPENSEND_MAX_BODY_BYTES,
        },
      );
      subject = rendered.subject;
      html = rendered.html;
      text = rendered.text;
      templateId = t.templateId;
      templateVersionId = t.version.id;
    } else {
      subject = input.subject!;
      html = input.html ?? null;
      text = input.text ?? null;
    }
    if (Buffer.byteLength(subject) > this.config.OPENSEND_MAX_SUBJECT_LENGTH) {
      throw new ApiError('payload_too_large', 'message subject too large', {
        limit: this.config.OPENSEND_MAX_SUBJECT_LENGTH,
      });
    }

    // --- sender authorization ----------------------------------------------------------
    const connection = await this.authorizeSender(
      tx,
      environment,
      domainOfAddress(prepared.from.email),
    );

    // --- suppressions ------------------------------------------------------------------
    const suppressed = await findSuppressed(
      tx,
      ctx.environmentId,
      prepared.recipients.map((r) => r.address),
    );
    const deliverable = prepared.recipients.filter((r) => !suppressed.has(r.address.toLowerCase()));
    const allSuppressed = deliverable.length === 0;

    // --- quota + backlog (serialized per project by the usage row lock) -----------------
    // Every accepted request creates durable records, even when every recipient is suppressed.
    // Charge all accepted recipients so suppression cannot bypass the tenant resource budget.
    await reserveRecipientQuota(tx, {
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
      emailId,
      recipients: prepared.recipients.length,
      limit: project.monthlyRecipientQuota ?? this.config.OPENSEND_DEFAULT_MONTHLY_QUOTA,
    });
    const [{ pending }] = (
      await tx.execute<{ pending: number }>(sql`
          SELECT count(*)::int AS pending FROM emails
           WHERE environment_id = ${ctx.environmentId}
             AND status IN (${sql.join(
               PENDING_STATUSES.map((s) => sql`${s}`),
               sql`, `,
             )})`)
    ).rows as [{ pending: number }];
    if (pending >= this.config.OPENSEND_MAX_PENDING_PER_ENVIRONMENT) {
      throw new ApiError(
        'backlog_limit_exceeded',
        'too many pending emails in this environment; retry later',
        {
          limit: this.config.OPENSEND_MAX_PENDING_PER_ENVIRONMENT,
        },
      );
    }

    // --- persist the job -----------------------------------------------------------------
    const status = allSuppressed ? 'suppressed' : prepared.scheduledAt ? 'scheduled' : 'queued';
    const now = new Date();
    await tx.insert(emails).values({
      id: emailId,
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
      apiKeyId: ctx.apiKeyId ?? null,
      createdByUserId: ctx.userId ?? null,
      status,
      fromAddress: prepared.from.email,
      fromName: prepared.from.name ?? null,
      subject,
      tags: input.tags ?? {},
      templateId,
      templateVersionId,
      scheduledAt: prepared.scheduledAt,
      providerConnectionId: connection.id,
      messageIdHeader: `<${emailId}@${domainOfAddress(prepared.from.email)}>`,
      recipientCount: prepared.recipients.length,
      batchId: ctx.batchId ?? null,
      resendOfEmailId: ctx.resendOfEmailId ?? null,
      acceptedAt: now,
      finalizedAt: allSuppressed ? now : null,
    });
    const content: StoredContent = {
      html,
      text,
      headers: input.headers ?? {},
      replyTo: prepared.replyTo,
    };
    await tx.insert(emailContents).values({
      emailId,
      projectId: ctx.projectId,
      ciphertext: this.keys.encryptJson(content, `email_content:${emailId}`),
    });
    const recipientRows = await tx
      .insert(emailRecipients)
      .values(
        prepared.recipients.map((r) => ({
          emailId,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          address: r.address,
          kind: r.kind,
          status: suppressed.has(r.address.toLowerCase())
            ? ('suppressed' as const)
            : ('pending' as const),
          statusDetail: suppressed.get(r.address.toLowerCase()) ?? null,
        })),
      )
      .returning({
        id: emailRecipients.id,
        address: emailRecipients.address,
        status: emailRecipients.status,
      });
    if (attachments.length > 0) {
      await tx.insert(emailAttachments).values(
        attachments.map((a) => ({
          id: a.id,
          emailId,
          projectId: ctx.projectId,
          objectKey: a.objectKey,
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.content.length,
          contentId: a.contentId ?? null,
        })),
      );
    }

    const ref = { id: emailId, projectId: ctx.projectId, environmentId: ctx.environmentId };
    await recordEmailEvent(tx, {
      email: ref,
      type: 'email.accepted',
      source: ctx.userId ? 'user' : 'system',
      occurredAt: now,
      data: {
        recipients: prepared.recipients.length,
        viaApiKey: Boolean(ctx.apiKeyId),
        templateVersionId,
        resendOf: ctx.resendOfEmailId,
      },
    });
    for (const r of recipientRows.filter((x) => x.status === 'suppressed')) {
      await recordEmailEvent(tx, {
        email: ref,
        type: 'recipient.suppressed',
        source: 'system',
        recipient: { id: r.id, address: r.address },
        data: { reason: suppressed.get(r.address.toLowerCase()) },
      });
    }
    if (allSuppressed) {
      await recordEmailEvent(tx, {
        email: ref,
        type: 'email.suppressed',
        source: 'system',
        webhookData: { status: 'suppressed' },
      });
    } else if (prepared.scheduledAt) {
      await recordEmailEvent(tx, {
        email: ref,
        type: 'email.scheduled',
        source: 'system',
        data: { scheduledAt: prepared.scheduledAt.toISOString() },
        webhookData: { scheduledAt: prepared.scheduledAt.toISOString() },
      });
      await enqueueOutbox(tx, {
        kind: 'send_email',
        refId: emailId,
        projectId: ctx.projectId,
        availableAt: prepared.scheduledAt,
      });
    } else {
      await recordEmailEvent(tx, { email: ref, type: 'email.queued', source: 'system' });
      await enqueueOutbox(tx, { kind: 'send_email', refId: emailId, projectId: ctx.projectId });
    }

    const body: AcceptedEmailResponse = {
      id: emailId,
      object: 'email',
      status,
      scheduledAt: prepared.scheduledAt?.toISOString() ?? null,
    };
    if (idempotencyKey) {
      await tx
        .update(idempotencyKeys)
        .set({ responseBody: body })
        .where(
          and(
            eq(idempotencyKeys.projectId, ctx.projectId),
            eq(idempotencyKeys.environmentId, ctx.environmentId),
            eq(idempotencyKeys.operation, operation),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        );
    }
    return { status: 202, body, replayed: false };
  }

  private async findIdempotent(
    db: Database | Tx,
    ctx: SendContext,
    operation: string,
    key: string,
  ) {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.projectId, ctx.projectId),
          eq(idempotencyKeys.environmentId, ctx.environmentId),
          eq(idempotencyKeys.operation, operation),
          eq(idempotencyKeys.key, key),
          sql`(${idempotencyKeys.expiresAt} > now() OR ${idempotencyKeys.emailId} IN (SELECT id FROM emails WHERE status IN (${sql.join(
            PENDING_STATUSES.map((s) => sql`${s}`),
            sql`, `,
          )})))`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private replay(row: typeof idempotencyKeys.$inferSelect, requestHash: string): AcceptResult {
    if (row.requestHash !== requestHash) {
      throw new ApiError(
        'idempotency_conflict',
        'Idempotency-Key was already used with a different request body',
      );
    }
    return {
      status: row.responseStatus,
      body: row.responseBody as AcceptedEmailResponse,
      replayed: true,
    };
  }

  private async resolveTemplate(tx: Tx, environmentId: string, ref: string, version?: number) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
    const [tpl] = await tx
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.environmentId, environmentId),
          isUuid ? eq(templates.id, ref) : eq(templates.slug, ref),
        ),
      )
      .limit(1);
    if (!tpl)
      throw new ApiError('validation_error', `template "${ref}" not found in this environment`, [
        { path: 'template.id', message: 'not found' },
      ]);
    const wanted = version ?? tpl.latestVersion;
    if (!wanted) throw new ApiError('validation_error', 'template has no published version');
    const [v] = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateId, tpl.id), eq(templateVersions.version, wanted)))
      .limit(1);
    if (!v) throw new ApiError('validation_error', `template version ${wanted} not found`);
    return { templateId: tpl.id, version: v };
  }

  /** Production only sends via verified sender domains and enabled, non-paused connections. */
  private async authorizeSender(
    tx: Tx,
    environment: typeof environments.$inferSelect,
    fromDomain: string,
  ) {
    const [connection] = await tx
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.environmentId, environment.id),
          eq(providerConnections.isDefault, true),
        ),
      )
      .limit(1);
    if (!connection || !connection.enabled) {
      throw new ApiError(
        'provider_unavailable',
        'no enabled default provider connection is configured for this environment',
      );
    }
    if (connection.pausedAt)
      throw new ApiError(
        'provider_unavailable',
        'the provider connection is paused by the platform operator',
      );
    if (connection.type === 'local') {
      if (environment.kind === 'production')
        throw new ApiError(
          'provider_unavailable',
          'the local provider cannot be used in production environments',
        );
      if (!this.config.OPENSEND_LOCAL_PROVIDER_ENABLED)
        throw new ApiError(
          'provider_unavailable',
          'the local provider is disabled on this instance',
        );
    }

    const [domain] = await tx
      .select()
      .from(domains)
      .where(and(eq(domains.environmentId, environment.id), eq(domains.name, fromDomain)))
      .limit(1);
    if (!domain) {
      throw new ApiError(
        'domain_not_verified',
        `sender domain "${fromDomain}" is not registered in this environment`,
      );
    }
    if (domain.localOnly) {
      if (connection.type !== 'local' || environment.kind === 'production') {
        throw new ApiError(
          'domain_not_verified',
          `"${fromDomain}" is a local-only test domain and can only be used with the local provider outside production`,
        );
      }
      return connection;
    }
    if (!domain.ownershipVerifiedAt) {
      throw new ApiError(
        'domain_not_verified',
        `ownership of "${fromDomain}" has not been verified`,
      );
    }
    if (PROVIDER_CAPABILITIES[connection.type].domainVerification) {
      if (domain.providerConnectionId !== connection.id || domain.providerStatus !== 'verified') {
        throw new ApiError(
          'domain_not_verified',
          `"${fromDomain}" is not verified with the ${connection.type} connection "${connection.name}"`,
        );
      }
    }
    return connection;
  }

  /** Used by the batch endpoint and tests: which of these emails are still pending? */
  async pendingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: emails.id })
      .from(emails)
      .where(and(inArray(emails.id, ids), inArray(emails.status, [...PENDING_STATUSES])));
    return rows.map((r) => r.id);
  }
}
