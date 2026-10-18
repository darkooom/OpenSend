import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import { ROLE, canGrantRole, type RoleName } from '@opensend/contracts';
import { randomToken, sha256Hex, writeAudit } from '@opensend/core';
import {
  and,
  count,
  desc,
  environments,
  eq,
  inArray,
  invitations,
  isNull,
  membershipProjects,
  memberships,
  organizations,
  projects,
  sql,
  user,
  type Database,
  type Tx,
} from '@opensend/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { AccessService, type OrgAccess } from '../access/access.service';
import { type Auth, createCredentialUser } from '../auth/auth';
import type { SessionUser } from '../auth/guards';
import { ApiError, forbidden, notFound } from '../common/errors';
import { parseOrThrow } from '../common/zod';
import { AUTH, CONFIG, DB, PLATFORM_MAILER } from '../infra/tokens';
import { accountEmails, type PlatformMailer } from '../mail/platform-mailer';
import { slugify } from './slug';

const projectAccessSchema = z
  .object({
    projectAccess: z.enum(['all', 'selected']).default('all'),
    projectIds: z.array(z.uuid()).max(500).default([]),
  })
  .refine((v) => v.projectAccess === 'all' || v.projectIds.length > 0, {
    message: 'select at least one project',
  });

const inviteSchema = z.intersection(
  z.object({ email: z.email().max(320), role: z.enum(ROLE) }),
  projectAccessSchema,
);
const updateMemberSchema = z.intersection(z.object({ role: z.enum(ROLE) }), projectAccessSchema);
const acceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(12).max(256).optional(),
});
const INVITATIONS_PER_DAY = 50;

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  environments: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        kind: z.enum(['development', 'staging', 'production']),
      }),
    )
    .min(1)
    .max(10)
    .default([{ name: 'development', kind: 'development' }]),
});

@Injectable()
export class OrgsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly access: AccessService,
    @Inject(PLATFORM_MAILER) private readonly mailer: PlatformMailer,
  ) {}

  async me(u: SessionUser) {
    const rows = await this.db
      .select({
        organization: organizations,
        role: memberships.role,
        projectAccess: memberships.projectAccess,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, u.id))
      .orderBy(organizations.name);
    return {
      user: u,
      memberships: rows.map((r) => ({
        organization: {
          id: r.organization.id,
          name: r.organization.name,
          slug: r.organization.slug,
        },
        role: r.role,
        projectAccess: r.projectAccess,
      })),
    };
  }

  /** Additional organizations are created by platform operators only (no open self-registration). */
  async createOrg(u: SessionUser, raw: unknown) {
    this.access.requirePlatformAdmin(u);
    const { name } = parseOrThrow(z.object({ name: z.string().trim().min(2).max(100) }), raw);
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({
          name,
          slug: `${slugify(name)}-${randomToken(3)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')}`,
        })
        .returning();
      await tx
        .insert(memberships)
        .values({ organizationId: org!.id, userId: u.id, role: 'owner', projectAccess: 'all' });
      await writeAudit(tx, {
        organizationId: org!.id,
        actorType: 'user',
        actorId: u.id,
        action: 'organization.create',
        targetType: 'organization',
        targetId: org!.id,
      });
      return org!;
    });
  }

  async getOrg(u: SessionUser, orgId: string) {
    const access = await this.access.requireOrg(u, orgId, 'org.read');
    const [org] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const visible = await this.access.visibleProjects(access);
    const envs = visible.length
      ? await this.db
          .select()
          .from(environments)
          .where(
            inArray(
              environments.projectId,
              visible.map((p) => p.id),
            ),
          )
          .orderBy(environments.createdAt)
      : [];
    return {
      organization: org,
      role: access.role,
      projectAccess: access.projectAccess,
      projects: visible.map((p) => ({
        ...this.projectView(p),
        environments: envs.filter((e) => e.projectId === p.id),
      })),
    };
  }

  projectView(p: typeof projects.$inferSelect) {
    return {
      id: p.id,
      organizationId: p.organizationId,
      name: p.name,
      slug: p.slug,
      retention: {
        contentDays: p.contentRetentionDays,
        attachmentDays: p.attachmentRetentionDays,
        eventDays: p.eventRetentionDays,
      },
      monthlyRecipientQuota: p.monthlyRecipientQuota ?? this.config.OPENSEND_DEFAULT_MONTHLY_QUOTA,
      paused: p.pausedAt ? { at: p.pausedAt.toISOString(), reason: p.pausedReason } : null,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async createProject(u: SessionUser, orgId: string, raw: unknown) {
    const access = await this.access.requireOrg(u, orgId, 'project.create');
    const input = parseOrThrow(createProjectSchema, raw);
    const names = new Set(input.environments.map((e) => e.name.toLowerCase()));
    if (names.size !== input.environments.length)
      throw new ApiError('validation_error', 'environment names must be unique');
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({
          organizationId: orgId,
          name: input.name,
          slug: `${slugify(input.name)}-${randomToken(3)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')}`,
        })
        .returning();
      const envs = await tx
        .insert(environments)
        .values(
          input.environments.map((e) => ({ projectId: project!.id, name: e.name, kind: e.kind })),
        )
        .returning();
      // A member restricted to selected projects automatically gets the project they created.
      if (access.projectAccess === 'selected') {
        await tx
          .insert(membershipProjects)
          .values({ membershipId: access.membershipId, projectId: project!.id });
      }
      await writeAudit(tx, {
        organizationId: orgId,
        projectId: project!.id,
        actorType: 'user',
        actorId: u.id,
        action: 'project.create',
        targetType: 'project',
        targetId: project!.id,
      });
      return { ...this.projectView(project!), environments: envs };
    });
  }

  /* --------------------------------- members --------------------------------- */

  async listMembers(u: SessionUser, orgId: string) {
    await this.access.requireOrg(u, orgId, 'org.read');
    const rows = await this.db
      .select({ m: memberships, email: user.email, name: user.name })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.organizationId, orgId))
      .orderBy(user.email);
    const grants = rows.length
      ? await this.db
          .select()
          .from(membershipProjects)
          .where(
            inArray(
              membershipProjects.membershipId,
              rows.map((r) => r.m.id),
            ),
          )
      : [];
    return rows.map((r) => ({
      id: r.m.id,
      userId: r.m.userId,
      email: r.email,
      name: r.name,
      role: r.m.role,
      projectAccess: r.m.projectAccess,
      projectIds: grants.filter((g) => g.membershipId === r.m.id).map((g) => g.projectId),
      createdAt: r.m.createdAt.toISOString(),
    }));
  }

  private async assertProjectsInOrg(tx: Database | Tx, orgId: string, ids: string[]) {
    if (ids.length === 0) return;
    const [row] = await tx
      .select({ n: count() })
      .from(projects)
      .where(and(eq(projects.organizationId, orgId), inArray(projects.id, ids)));
    if (Number(row?.n ?? 0) !== new Set(ids).size)
      throw new ApiError(
        'validation_error',
        'projectIds contain projects outside this organization',
      );
  }

  private assertCanGrant(actor: OrgAccess, role: RoleName, projectAccess: 'all' | 'selected') {
    if (!canGrantRole(actor.role, role))
      throw forbidden(`a ${actor.role} cannot grant the ${role} role`);
    // A member restricted to selected projects cannot hand out organization-wide access.
    if (actor.projectAccess === 'selected' && projectAccess === 'all')
      throw forbidden('you cannot grant access to all projects');
  }

  private async assertActorSeesProjects(actor: OrgAccess, ids: string[]) {
    for (const id of ids)
      if (!(await this.access.canSeeProject(actor, id)))
        throw forbidden('you cannot grant access to projects you cannot see');
  }

  async updateMember(
    u: SessionUser,
    orgId: string,
    membershipId: string,
    raw: unknown,
    ip: string | null,
  ) {
    const actor = await this.access.requireOrg(u, orgId, 'members.manage');
    const input = parseOrThrow(updateMemberSchema, raw);
    const [target] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
      .limit(1);
    if (!target) throw notFound('member');
    if (target.role === 'owner' && actor.role !== 'owner')
      throw forbidden('only owners can change an owner');
    this.assertCanGrant(actor, input.role, input.projectAccess);
    await this.assertActorSeesProjects(actor, input.projectIds);
    return this.db.transaction(async (tx) => {
      await this.assertProjectsInOrg(tx, orgId, input.projectIds);
      if (target.role === 'owner' && input.role !== 'owner')
        await this.assertAnotherOwner(tx, orgId, target.id);
      await tx
        .update(memberships)
        .set({ role: input.role, projectAccess: input.projectAccess })
        .where(eq(memberships.id, target.id));
      await tx.delete(membershipProjects).where(eq(membershipProjects.membershipId, target.id));
      if (input.projectAccess === 'selected') {
        await tx.insert(membershipProjects).values(
          [...new Set(input.projectIds)].map((projectId) => ({
            membershipId: target.id,
            projectId,
          })),
        );
      }
      await writeAudit(tx, {
        organizationId: orgId,
        actorType: 'user',
        actorId: u.id,
        action: 'member.update',
        targetType: 'membership',
        targetId: target.id,
        metadata: {
          from: target.role,
          to: input.role,
          projectAccess: input.projectAccess,
          projectIds: input.projectIds,
        },
        ipAddress: ip,
      });
      return {
        id: target.id,
        role: input.role,
        projectAccess: input.projectAccess,
        projectIds: input.projectIds,
      };
    });
  }

  async removeMember(u: SessionUser, orgId: string, membershipId: string, ip: string | null) {
    const actor = await this.access.requireOrg(u, orgId, 'members.manage');
    const [target] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
      .limit(1);
    if (!target) throw notFound('member');
    if (target.role === 'owner' && actor.role !== 'owner')
      throw forbidden('only owners can remove an owner');
    await this.db.transaction(async (tx) => {
      if (target.role === 'owner') await this.assertAnotherOwner(tx, orgId, target.id);
      await tx.delete(memberships).where(eq(memberships.id, target.id));
      await writeAudit(tx, {
        organizationId: orgId,
        actorType: 'user',
        actorId: u.id,
        action: 'member.remove',
        targetType: 'membership',
        targetId: target.id,
        ipAddress: ip,
      });
    });
  }

  private async assertAnotherOwner(tx: Tx, orgId: string, exceptMembershipId: string) {
    // Lock the remaining owner rows so two concurrent demotions cannot remove the last owner.
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM memberships
       WHERE organization_id = ${orgId} AND role = 'owner' AND id <> ${exceptMembershipId}
       FOR UPDATE`);
    if (rows.rows.length === 0)
      throw new ApiError('conflict', 'an organization must keep at least one owner');
  }

  /* ------------------------------- invitations ------------------------------- */

  async listInvitations(u: SessionUser, orgId: string) {
    await this.access.requireOrg(u, orgId, 'members.manage');
    const rows = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .orderBy(desc(invitations.createdAt));
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      projectAccess: i.projectAccess,
      projectIds: i.projectIds,
      expiresAt: i.expiresAt.toISOString(),
      expired: i.expiresAt.getTime() < Date.now(),
      createdAt: i.createdAt.toISOString(),
    }));
  }

  /**
   * Returns the invitation link once. When the operator configured a platform sender the link
   * is also emailed to the invitee; otherwise the inviter shares it.
   */
  async invite(u: SessionUser, orgId: string, raw: unknown, ip: string | null) {
    const actor = await this.access.requireOrg(u, orgId, 'members.manage');
    const input = parseOrThrow(inviteSchema, raw);
    this.assertCanGrant(actor, input.role, input.projectAccess);
    await this.assertActorSeesProjects(actor, input.projectIds);
    const token = randomToken(32);
    const email = input.email.toLowerCase();
    const row = await this.db.transaction(async (tx) => {
      await this.assertProjectsInOrg(tx, orgId, input.projectIds);
      const existing = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(user, eq(user.id, memberships.userId))
        .where(and(eq(memberships.organizationId, orgId), eq(user.email, email)))
        .limit(1);
      if (existing.length) throw new ApiError('conflict', 'this person is already a member');
      // Invitations can send email, so they are capped per organization and day.
      const recent = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM invitations
         WHERE organization_id = ${orgId} AND created_at > now() - interval '24 hours'`);
      if (Number(recent.rows[0]?.n ?? 0) >= INVITATIONS_PER_DAY) {
        throw new ApiError(
          'rate_limited',
          `at most ${INVITATIONS_PER_DAY} invitations per organization and day`,
        );
      }
      const [inv] = await tx
        .insert(invitations)
        .values({
          organizationId: orgId,
          email,
          role: input.role,
          projectAccess: input.projectAccess,
          projectIds: input.projectAccess === 'selected' ? [...new Set(input.projectIds)] : [],
          tokenHash: sha256Hex(token),
          invitedByUserId: u.id,
          expiresAt: new Date(Date.now() + this.config.OPENSEND_INVITATION_TTL_HOURS * 3_600_000),
        })
        .returning();
      await writeAudit(tx, {
        organizationId: orgId,
        actorType: 'user',
        actorId: u.id,
        action: 'invitation.create',
        targetType: 'invitation',
        targetId: inv!.id,
        metadata: { role: input.role, projectAccess: input.projectAccess },
        ipAddress: ip,
      });
      return inv!;
    });
    const url = `${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`;
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const emailSent = await this.mailer.send(
      accountEmails.invitation({
        to: row.email,
        organization: org?.name ?? 'an organization',
        role: row.role,
        inviter: u.name || u.email,
        url,
        expiresAt: row.expiresAt,
      }),
    );
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      url,
      emailSent,
    };
  }

  async revokeInvitation(u: SessionUser, orgId: string, invitationId: string, ip: string | null) {
    await this.access.requireOrg(u, orgId, 'members.manage');
    const rows = await this.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.organizationId, orgId),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (!rows.length) throw notFound('invitation');
    await writeAudit(this.db, {
      organizationId: orgId,
      actorType: 'user',
      actorId: u.id,
      action: 'invitation.revoke',
      targetType: 'invitation',
      targetId: invitationId,
      ipAddress: ip,
    });
  }

  private async findOpenInvitation(db: Database | Tx, token: string) {
    const [inv] = await db
      .select({ inv: invitations, orgName: organizations.name })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .where(
        and(
          eq(invitations.tokenHash, sha256Hex(token)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .limit(1);
    if (!inv || inv.inv.expiresAt.getTime() < Date.now())
      throw new ApiError('not_found', 'invitation not found or expired');
    return inv;
  }

  async lookupInvitation(token: string) {
    if (!token || token.length > 200)
      throw new ApiError('not_found', 'invitation not found or expired');
    const { inv, orgName } = await this.findOpenInvitation(this.db, token);
    const [existing] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, inv.email))
      .limit(1);
    return {
      organizationName: orgName,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt.toISOString(),
      accountExists: Boolean(existing),
    };
  }

  /**
   * Accepting creates the account (if needed) and the membership with exactly the role and
   * project scope fixed at invitation time. An existing account must be signed in.
   */
  async acceptInvitation(raw: unknown, headers: IncomingHttpHeaders, ip: string | null) {
    const input = parseOrThrow(acceptSchema, raw);
    const { inv } = await this.findOpenInvitation(this.db, input.token);
    const [existing] = await this.db.select().from(user).where(eq(user.email, inv.email)).limit(1);
    let userId: string;
    if (existing) {
      const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!session || session.user.id !== existing.id)
        throw new ApiError('unauthorized', 'sign in as the invited user to accept this invitation');
      userId = existing.id;
    } else {
      if (!input.name || !input.password)
        throw new ApiError(
          'validation_error',
          'name and password (min. 12 characters) are required',
        );
      const created = await createCredentialUser(this.auth, {
        email: inv.email,
        name: input.name,
        password: input.password,
      });
      userId = created.id;
    }
    await this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitations.id, inv.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (!claimed.length) throw new ApiError('conflict', 'invitation was already used');
      const [m] = await tx
        .insert(memberships)
        .values({
          organizationId: inv.organizationId,
          userId,
          role: inv.role,
          projectAccess: inv.projectAccess,
        })
        .onConflictDoNothing()
        .returning();
      if (!m) throw new ApiError('conflict', 'already a member of this organization');
      if (inv.projectAccess === 'selected' && inv.projectIds.length) {
        const stillThere = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, inv.organizationId),
              inArray(projects.id, inv.projectIds),
            ),
          );
        if (stillThere.length)
          await tx
            .insert(membershipProjects)
            .values(stillThere.map((p) => ({ membershipId: m.id, projectId: p.id })));
      }
      await writeAudit(tx, {
        organizationId: inv.organizationId,
        actorType: 'user',
        actorId: userId,
        action: 'invitation.accept',
        targetType: 'invitation',
        targetId: inv.id,
        ipAddress: ip,
      });
    });
    return { organizationId: inv.organizationId, email: inv.email };
  }
}
