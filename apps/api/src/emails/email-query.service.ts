import { Inject, Injectable } from '@nestjs/common';
import {
  displayStatus,
  emailListQuerySchema,
  summarizeRecipients,
  type EmailListItem,
  type EmailResource,
  type RecipientStatus,
} from '@opensend/contracts';
import {
  and,
  asc,
  desc,
  emailAttachments,
  emailEvents,
  emailRecipients,
  emails,
  eq,
  inArray,
  lt,
  or,
  sendAttempts,
  sql,
  type Database,
} from '@opensend/db';
import { notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { DB } from '../infra/tokens';

type EmailRow = typeof emails.$inferSelect;
type RecipientRow = typeof emailRecipients.$inferSelect;

export interface Scope {
  projectId: string;
  environmentId: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function encodeCursor(row: EmailRow): string {
  return Buffer.from(`${row.acceptedAt.toISOString()}|${row.id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at: new Date(at), id };
}

/**
 * Read model for emails. Every query is filtered by BOTH project and environment taken from
 * the authenticated context (API key or AccessService), never from request parameters alone.
 */
@Injectable()
export class EmailQueryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  toResource(row: EmailRow, recipients: RecipientRow[]): EmailResource {
    const summary = summarizeRecipients(
      recipients.map((r) => ({
        status: r.status as RecipientStatus,
        deliveredAt: iso(r.deliveredAt),
        bouncedAt: iso(r.bouncedAt),
        complainedAt: iso(r.complainedAt),
      })),
    );
    return {
      id: row.id,
      object: 'email',
      status: row.status,
      displayStatus: displayStatus(row.status, summary),
      from: row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress,
      subject: row.subject,
      tags: row.tags as Record<string, string>,
      scheduledAt: iso(row.scheduledAt),
      createdAt: row.acceptedAt.toISOString(),
      submittedAt: iso(row.submittedAt),
      cancelledAt: iso(row.cancelledAt),
      attempts: row.attemptCount,
      lastError:
        row.lastErrorCode || row.failureCategory
          ? {
              category: row.failureCategory,
              code: row.lastErrorCode,
              message: row.lastErrorMessage,
            }
          : null,
      recipients: recipients.map((r) => ({
        address: r.address,
        kind: r.kind,
        status: r.status as RecipientStatus,
        statusDetail: r.statusDetail,
        deliveredAt: iso(r.deliveredAt),
        bouncedAt: iso(r.bouncedAt),
        bounceType: r.bounceType,
        complainedAt: iso(r.complainedAt),
        deferredAt: iso(r.deferredAt),
      })),
      summary,
      templateId: row.templateId,
      templateVersionId: row.templateVersionId,
      batchId: row.batchId,
      resendOf: row.resendOfEmailId,
      contentPurged: Boolean(row.contentPurgedAt),
    };
  }

  async list(
    scope: Scope,
    rawQuery: unknown,
  ): Promise<{ object: 'list'; data: EmailListItem[]; nextCursor: string | null }> {
    const q = parseOrThrow(emailListQuerySchema, rawQuery);
    const conds = [
      eq(emails.projectId, scope.projectId),
      eq(emails.environmentId, scope.environmentId),
    ];
    if (q.status) conds.push(eq(emails.status, q.status));
    if (q.from) conds.push(sql`${emails.acceptedAt} >= ${new Date(q.from)}`);
    if (q.to) conds.push(sql`${emails.acceptedAt} < ${new Date(q.to)}`);
    if (q.recipient) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM email_recipients r WHERE r.email_id = ${emails.id} AND r.environment_id = ${scope.environmentId} AND lower(r.address) = ${q.recipient.toLowerCase()})`,
      );
    }
    if (q.tag) {
      const idx = q.tag.indexOf(':');
      const name = idx >= 0 ? q.tag.slice(0, idx) : q.tag;
      const value = idx >= 0 ? q.tag.slice(idx + 1) : undefined;
      conds.push(
        value === undefined
          ? sql`${emails.tags} ? ${name}`
          : sql`${emails.tags} ->> ${name} = ${value}`,
      );
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (c)
        conds.push(
          or(lt(emails.acceptedAt, c.at), and(eq(emails.acceptedAt, c.at), lt(emails.id, c.id)))!,
        );
    }
    const rows = await this.db
      .select()
      .from(emails)
      .where(and(...conds))
      .orderBy(desc(emails.acceptedAt), desc(emails.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const recipients = page.length
      ? await this.db
          .select()
          .from(emailRecipients)
          .where(
            inArray(
              emailRecipients.emailId,
              page.map((r) => r.id),
            ),
          )
      : [];
    const byEmail = new Map<string, RecipientRow[]>();
    for (const r of recipients) byEmail.set(r.emailId, [...(byEmail.get(r.emailId) ?? []), r]);
    return {
      object: 'list',
      data: page.map((row) => {
        const { recipients: _r, ...item } = this.toResource(row, byEmail.get(row.id) ?? []);
        return item;
      }),
      nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  async getRow(scope: Scope, id: string): Promise<EmailRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('email');
    const [row] = await this.db
      .select()
      .from(emails)
      .where(
        and(
          eq(emails.id, id),
          eq(emails.projectId, scope.projectId),
          eq(emails.environmentId, scope.environmentId),
        ),
      )
      .limit(1);
    if (!row) throw notFound('email');
    return row;
  }

  async get(scope: Scope, id: string): Promise<EmailResource> {
    const row = await this.getRow(scope, id);
    const recipients = await this.db
      .select()
      .from(emailRecipients)
      .where(eq(emailRecipients.emailId, row.id))
      .orderBy(asc(emailRecipients.createdAt));
    return this.toResource(row, recipients);
  }

  /** Dashboard detail: attempts, timeline and attachment metadata (no content). */
  async detail(scope: Scope, id: string) {
    const email = await this.get(scope, id);
    const [attempts, events, attachments] = await Promise.all([
      this.db
        .select()
        .from(sendAttempts)
        .where(eq(sendAttempts.emailId, id))
        .orderBy(asc(sendAttempts.attemptNumber)),
      this.db
        .select()
        .from(emailEvents)
        .where(eq(emailEvents.emailId, id))
        .orderBy(asc(emailEvents.occurredAt), asc(emailEvents.recordedAt)),
      this.db
        .select({
          id: emailAttachments.id,
          filename: emailAttachments.filename,
          contentType: emailAttachments.contentType,
          sizeBytes: emailAttachments.sizeBytes,
          purgedAt: emailAttachments.purgedAt,
        })
        .from(emailAttachments)
        .where(eq(emailAttachments.emailId, id)),
    ]);
    const recipientById = new Map<string, string>();
    const recRows = await this.db
      .select({ id: emailRecipients.id, address: emailRecipients.address })
      .from(emailRecipients)
      .where(eq(emailRecipients.emailId, id));
    for (const r of recRows) recipientById.set(r.id, r.address);
    return {
      ...email,
      attemptsDetail: attempts.map((a) => ({
        number: a.attemptNumber,
        outcome: a.outcome,
        errorCategory: a.errorCategory,
        errorCode: a.errorCode,
        errorMessage: a.errorMessage,
        providerMessageId: a.providerMessageId,
        providerResponse: a.providerResponse,
        startedAt: a.startedAt.toISOString(),
        finishedAt: iso(a.finishedAt),
      })),
      timeline: events.map((e) => ({
        id: e.id,
        type: e.type,
        source: e.source,
        recipient: e.recipientId ? (recipientById.get(e.recipientId) ?? null) : null,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        data: e.data,
      })),
      attachments: attachments.map((a) => ({ ...a, purgedAt: iso(a.purgedAt) })),
    };
  }
}
