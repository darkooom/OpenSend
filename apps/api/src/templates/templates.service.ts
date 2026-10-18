import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import {
  TemplateError,
  renderTemplate,
  resolveValues,
  templateVariableSchema,
  validateTemplateSource,
  writeAudit,
  type TemplateVariable,
} from '@opensend/core';
import { and, desc, eq, templateVersions, templates, type Database } from '@opensend/db';
import { z } from 'zod';
import type { EnvironmentAccess } from '../access/access.service';
import type { SessionUser } from '../auth/guards';
import { ApiError, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { CONFIG, DB } from '../infra/tokens';

const draftSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes'),
  subject: z.string().max(998),
  html: z.string().max(1_000_000).nullable().optional(),
  text: z.string().max(1_000_000).nullable().optional(),
  variables: z.array(templateVariableSchema).max(100).default([]),
});
// No defaults here: an omitted field means "unchanged".
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes')
    .optional(),
  subject: z.string().max(998).optional(),
  html: z.string().max(1_000_000).nullable().optional(),
  text: z.string().max(1_000_000).nullable().optional(),
  variables: z.array(templateVariableSchema).max(100).optional(),
});
const previewSchema = z.object({
  version: z.number().int().positive().optional(),
  variables: z
    .record(z.string(), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]))
    .default({}),
});

type TemplateRow = typeof templates.$inferSelect;

/**
 * Templates have one editable draft and immutable published versions. Emails bind to a
 * version AND persist their rendered output, so edits never change accepted emails.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private view(t: TemplateRow) {
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      draft: {
        subject: t.draftSubject,
        html: t.draftHtml,
        text: t.draftText,
        variables: t.draftVariables as TemplateVariable[],
      },
      latestVersion: t.latestVersion,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private validate(
    subject: string,
    html: string | null | undefined,
    text: string | null | undefined,
    variables: TemplateVariable[],
  ) {
    const names = variables.map((v) => v.name);
    if (new Set(names).size !== names.length)
      throw new ApiError('validation_error', 'variable names must be unique');
    try {
      validateTemplateSource({ subject, html, text }, variables);
    } catch (err) {
      if (err instanceof TemplateError)
        throw new ApiError('validation_error', err.message, err.details);
      throw err;
    }
  }

  async list(a: EnvironmentAccess) {
    const rows = await this.db
      .select()
      .from(templates)
      .where(
        and(eq(templates.projectId, a.project.id), eq(templates.environmentId, a.environment.id)),
      )
      .orderBy(templates.name);
    return rows.map((r) => this.view(r));
  }

  private async load(a: EnvironmentAccess, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('template');
    const [t] = await this.db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.id, id),
          eq(templates.projectId, a.project.id),
          eq(templates.environmentId, a.environment.id),
        ),
      )
      .limit(1);
    if (!t) throw notFound('template');
    return t;
  }

  async get(a: EnvironmentAccess, id: string) {
    const t = await this.load(a, id);
    const versions = await this.db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.templateId, t.id))
      .orderBy(desc(templateVersions.version));
    return {
      ...this.view(t),
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        subject: v.subject,
        publishedAt: v.publishedAt.toISOString(),
      })),
    };
  }

  async create(a: EnvironmentAccess, u: SessionUser, raw: unknown) {
    const input = parseOrThrow(draftSchema, raw);
    this.validate(input.subject, input.html, input.text, input.variables);
    const rows = await this.db
      .insert(templates)
      .values({
        projectId: a.project.id,
        environmentId: a.environment.id,
        name: input.name,
        slug: input.slug,
        draftSubject: input.subject,
        draftHtml: input.html ?? null,
        draftText: input.text ?? null,
        draftVariables: input.variables,
      })
      .onConflictDoNothing()
      .returning();
    if (!rows.length)
      throw new ApiError('conflict', `a template with slug "${input.slug}" already exists`);
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'template.create',
      targetType: 'template',
      targetId: rows[0]!.id,
    });
    return this.view(rows[0]!);
  }

  async update(a: EnvironmentAccess, raw: unknown, id: string) {
    const input = parseOrThrow(updateSchema, raw);
    const t = await this.load(a, id);
    const next = {
      subject: input.subject ?? t.draftSubject,
      html: input.html !== undefined ? input.html : t.draftHtml,
      text: input.text !== undefined ? input.text : t.draftText,
      variables: input.variables ?? (t.draftVariables as TemplateVariable[]),
    };
    this.validate(next.subject, next.html, next.text, next.variables);
    const [row] = await this.db
      .update(templates)
      .set({
        name: input.name ?? t.name,
        slug: input.slug ?? t.slug,
        draftSubject: next.subject,
        draftHtml: next.html ?? null,
        draftText: next.text ?? null,
        draftVariables: next.variables,
        updatedAt: new Date(),
      })
      .where(eq(templates.id, t.id))
      .returning();
    return this.view(row!);
  }

  async publish(a: EnvironmentAccess, u: SessionUser, id: string) {
    const t = await this.load(a, id);
    if (!t.draftHtml && !t.draftText)
      throw new ApiError(
        'validation_error',
        'a template needs an HTML or text body before publishing',
      );
    if (!t.draftSubject)
      throw new ApiError('validation_error', 'a template needs a subject before publishing');
    this.validate(t.draftSubject, t.draftHtml, t.draftText, t.draftVariables as TemplateVariable[]);
    return this.db.transaction(async (tx) => {
      // Lock the template row so concurrent publishes get distinct version numbers.
      const [locked] = await tx
        .select()
        .from(templates)
        .where(eq(templates.id, t.id))
        .for('update');
      const version = (locked!.latestVersion ?? 0) + 1;
      const [v] = await tx
        .insert(templateVersions)
        .values({
          templateId: t.id,
          projectId: a.project.id,
          version,
          subject: locked!.draftSubject,
          html: locked!.draftHtml,
          text: locked!.draftText,
          variables: locked!.draftVariables,
          publishedByUserId: u.id,
        })
        .returning();
      await tx
        .update(templates)
        .set({ latestVersion: version, updatedAt: new Date() })
        .where(eq(templates.id, t.id));
      await writeAudit(tx, {
        organizationId: a.organizationId,
        projectId: a.project.id,
        actorType: 'user',
        actorId: u.id,
        action: 'template.publish',
        targetType: 'template',
        targetId: t.id,
        metadata: { version },
      });
      return { id: v!.id, version, publishedAt: v!.publishedAt.toISOString() };
    });
  }

  /** Renders the draft (or a published version) with sample/test data. */
  async preview(a: EnvironmentAccess, id: string, raw: unknown) {
    const input = parseOrThrow(previewSchema, raw ?? {});
    const t = await this.load(a, id);
    let source = {
      subject: t.draftSubject,
      html: t.draftHtml,
      text: t.draftText,
      variables: t.draftVariables as TemplateVariable[],
    };
    if (input.version) {
      const [v] = await this.db
        .select()
        .from(templateVersions)
        .where(
          and(eq(templateVersions.templateId, t.id), eq(templateVersions.version, input.version)),
        )
        .limit(1);
      if (!v) throw notFound('template version');
      source = {
        subject: v.subject,
        html: v.html,
        text: v.text,
        variables: v.variables as TemplateVariable[],
      };
    }
    try {
      const values = resolveValues(source.variables, input.variables, 'preview');
      return renderTemplate(source, values, {
        maxSubjectBytes: this.config.OPENSEND_MAX_SUBJECT_LENGTH,
        maxBodyBytes: this.config.OPENSEND_MAX_BODY_BYTES,
      });
    } catch (err) {
      if (err instanceof TemplateError)
        throw new ApiError('validation_error', err.message, err.details);
      throw err;
    }
  }

  async remove(a: EnvironmentAccess, u: SessionUser, id: string) {
    const t = await this.load(a, id);
    await this.db.delete(templates).where(eq(templates.id, t.id));
    await writeAudit(this.db, {
      organizationId: a.organizationId,
      projectId: a.project.id,
      actorType: 'user',
      actorId: u.id,
      action: 'template.delete',
      targetType: 'template',
      targetId: t.id,
    });
  }
}
