import { Inject, Injectable } from '@nestjs/common';
import { CANCELLABLE_STATUSES } from '@opensend/contracts';
import {
  KeyRing,
  getDecrypted,
  recordEmailEvent,
  writeAudit,
  type ObjectStore,
} from '@opensend/core';
import {
  and,
  emailAttachments,
  emailContents,
  emailRecipients,
  emails,
  eq,
  inArray,
  isNull,
  outbox,
  type Database,
} from '@opensend/db';
import { z } from 'zod';
import { ApiError, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { DB, KEYRING, OBJECT_STORE } from '../infra/tokens';
import { AcceptanceService, type StoredContent } from './acceptance.service';
import { EmailQueryService, type Scope } from './email-query.service';

export interface Actor {
  type: 'user' | 'api_key';
  id: string;
  organizationId: string;
  ip?: string | null;
}

const resendSchema = z.object({ confirmDuplicate: z.boolean().default(false) }).strict();

@Injectable()
export class EmailActionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(KEYRING) private readonly keys: KeyRing,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly query: EmailQueryService,
    private readonly acceptance: AcceptanceService,
  ) {}

  /**
   * Cancel before hand-off. The conditional UPDATE races safely with the worker's claim:
   * whichever commits first wins, the other affects zero rows.
   */
  async cancel(scope: Scope, id: string, actor: Actor) {
    await this.query.getRow(scope, id);
    const now = new Date();
    const cancelled = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(emails)
        .set({ status: 'cancelled', cancelledAt: now, finalizedAt: now, updatedAt: now })
        .where(
          and(
            eq(emails.id, id),
            eq(emails.projectId, scope.projectId),
            eq(emails.environmentId, scope.environmentId),
            inArray(emails.status, [...CANCELLABLE_STATUSES]),
          ),
        )
        .returning();
      if (!row) return null;
      await tx
        .update(emailRecipients)
        .set({ status: 'cancelled' })
        .where(and(eq(emailRecipients.emailId, id), eq(emailRecipients.status, 'pending')));
      await tx
        .update(outbox)
        .set({ completedAt: now })
        .where(
          and(eq(outbox.kind, 'send_email'), eq(outbox.refId, id), isNull(outbox.completedAt)),
        );
      await recordEmailEvent(tx, {
        email: { id, projectId: scope.projectId, environmentId: scope.environmentId },
        type: 'email.cancelled',
        source: actor.type === 'user' ? 'user' : 'system',
        data: { actorType: actor.type },
        webhookData: { status: 'cancelled' },
      });
      if (actor.type === 'user') {
        await writeAudit(tx, {
          organizationId: actor.organizationId,
          projectId: scope.projectId,
          actorType: 'user',
          actorId: actor.id,
          action: 'email.cancel',
          targetType: 'email',
          targetId: id,
          ipAddress: actor.ip,
        });
      }
      return row;
    });
    if (!cancelled) {
      const current = await this.query.getRow(scope, id);
      throw new ApiError(
        'not_cancellable',
        `email can no longer be cancelled (status: ${current.status})`,
        { status: current.status },
      );
    }
    return this.query.get(scope, id);
  }

  async loadContent(
    scope: Scope,
    id: string,
  ): Promise<{ email: typeof emails.$inferSelect; content: StoredContent | null }> {
    const email = await this.query.getRow(scope, id);
    const [c] = await this.db
      .select()
      .from(emailContents)
      .where(eq(emailContents.emailId, email.id))
      .limit(1);
    return {
      email,
      content: c
        ? this.keys.decryptJson<StoredContent>(c.ciphertext, `email_content:${email.id}`)
        : null,
    };
  }

  async content(scope: Scope, id: string) {
    const { email, content } = await this.loadContent(scope, id);
    return {
      subject: email.subject,
      purged: content === null,
      html: content?.html ?? null,
      text: content?.text ?? null,
      headers: content?.headers ?? {},
      replyTo: content?.replyTo ?? [],
    };
  }

  async attachment(scope: Scope, emailId: string, attachmentId: string) {
    const email = await this.query.getRow(scope, emailId);
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw notFound('attachment');
    const [a] = await this.db
      .select()
      .from(emailAttachments)
      .where(
        and(
          eq(emailAttachments.id, attachmentId),
          eq(emailAttachments.emailId, email.id),
          eq(emailAttachments.projectId, scope.projectId),
        ),
      )
      .limit(1);
    if (!a || a.purgedAt) throw notFound('attachment');
    const body = await getDecrypted(this.store, this.keys, a.objectKey);
    return { filename: a.filename, body };
  }

  /**
   * Manual resend creates a NEW linked email. If the original may already have reached the
   * transport (submitted / submission_unknown) the caller must confirm the possible duplicate.
   */
  async resend(scope: Scope, id: string, rawBody: unknown, actor: Actor) {
    const opts = parseOrThrow(resendSchema, rawBody ?? {});
    const { email, content } = await this.loadContent(scope, id);
    if (!content || email.contentPurgedAt)
      throw new ApiError(
        'conflict',
        'the original content is no longer stored (retention policy); it cannot be resent',
      );
    if (['accepted', 'scheduled', 'queued', 'submitting', 'retry_wait'].includes(email.status)) {
      throw new ApiError('conflict', `email is still in progress (status: ${email.status})`);
    }
    if (['submitted', 'submission_unknown'].includes(email.status) && !opts.confirmDuplicate) {
      throw new ApiError(
        'conflict',
        'the original email may already have been delivered; set confirmDuplicate to send a possible duplicate',
        {
          status: email.status,
          requiresConfirmation: true,
        },
      );
    }
    const recipients = await this.db
      .select()
      .from(emailRecipients)
      .where(eq(emailRecipients.emailId, email.id));
    const attachments = await this.db
      .select()
      .from(emailAttachments)
      .where(and(eq(emailAttachments.emailId, email.id), isNull(emailAttachments.purgedAt)));
    const files = await Promise.all(
      attachments.map(async (a) => ({
        filename: a.filename,
        contentType: a.contentType,
        contentId: a.contentId ?? undefined,
        content: (await getDecrypted(this.store, this.keys, a.objectKey)).toString('base64'),
      })),
    );
    const byKind = (k: 'to' | 'cc' | 'bcc') =>
      recipients.filter((r) => r.kind === k).map((r) => r.address);
    const request = {
      from: email.fromName ? { email: email.fromAddress, name: email.fromName } : email.fromAddress,
      to: byKind('to'),
      cc: byKind('cc'),
      bcc: byKind('bcc'),
      replyTo: content.replyTo,
      subject: email.subject ?? '',
      html: content.html ?? undefined,
      text: content.text ?? undefined,
      headers: content.headers,
      tags: email.tags as Record<string, string>,
      attachments: files.length ? files : undefined,
    };
    const result = await this.acceptance.accept(
      {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: actor.type === 'user' ? actor.id : undefined,
        resendOfEmailId: email.id,
      },
      request,
    );
    await this.db.transaction(async (tx) => {
      await recordEmailEvent(tx, {
        email: { id: email.id, projectId: scope.projectId, environmentId: scope.environmentId },
        type: 'email.resent',
        source: 'user',
        data: { newEmailId: result.body.id, duplicateConfirmed: opts.confirmDuplicate },
      });
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        projectId: scope.projectId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'email.resend',
        targetType: 'email',
        targetId: email.id,
        metadata: {
          newEmailId: result.body.id,
          originalStatus: email.status,
          duplicateConfirmed: opts.confirmDuplicate,
        },
        ipAddress: actor.ip,
      });
    });
    return result.body;
  }
}
