import { Inject, Injectable } from '@nestjs/common';
import { roleHas, type Permission, type RoleName } from '@opensend/contracts';
import {
  and,
  environments,
  eq,
  membershipProjects,
  memberships,
  projects,
  type Database,
} from '@opensend/db';
import type { SessionUser } from '../auth/guards';
import { ApiError, forbidden, notFound } from '../common/errors';
import { DB } from '../infra/tokens';

export type ProjectRow = typeof projects.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;

export interface OrgAccess {
  organizationId: string;
  membershipId: string;
  role: RoleName;
  projectAccess: 'all' | 'selected';
}

export interface ProjectAccess extends OrgAccess {
  project: ProjectRow;
}

export interface EnvironmentAccess extends ProjectAccess {
  environment: EnvironmentRow;
}

/**
 * Central authorization. Every management route resolves its organization / project /
 * environment through this service; ids from the request are never trusted on their own.
 * Missing access to a project is reported as 404 to avoid confirming that it exists.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async orgAccess(user: SessionUser, organizationId: string): Promise<OrgAccess | null> {
    if (!/^[0-9a-f-]{36}$/i.test(organizationId)) return null;
    const [m] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, user.id)))
      .limit(1);
    if (!m) return null;
    return { organizationId, membershipId: m.id, role: m.role, projectAccess: m.projectAccess };
  }

  async requireOrg(
    user: SessionUser,
    organizationId: string,
    permission: Permission,
  ): Promise<OrgAccess> {
    const access = await this.orgAccess(user, organizationId);
    if (!access) throw notFound('organization');
    if (!roleHas(access.role, permission)) throw forbidden();
    return access;
  }

  async canSeeProject(access: OrgAccess, projectId: string): Promise<boolean> {
    if (access.projectAccess === 'all') return true;
    const [row] = await this.db
      .select({ p: membershipProjects.projectId })
      .from(membershipProjects)
      .where(
        and(
          eq(membershipProjects.membershipId, access.membershipId),
          eq(membershipProjects.projectId, projectId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async requireProject(
    user: SessionUser,
    projectId: string,
    permission: Permission,
  ): Promise<ProjectAccess> {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw notFound('project');
    const [project] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('project');
    const access = await this.orgAccess(user, project.organizationId);
    if (!access || !(await this.canSeeProject(access, project.id))) throw notFound('project');
    if (!roleHas(access.role, permission)) throw forbidden();
    return { ...access, project };
  }

  async requireEnvironment(
    user: SessionUser,
    projectId: string,
    environmentId: string,
    permission: Permission,
  ): Promise<EnvironmentAccess> {
    const access = await this.requireProject(user, projectId, permission);
    if (!/^[0-9a-f-]{36}$/i.test(environmentId)) throw notFound('environment');
    const [environment] = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.projectId, access.project.id)))
      .limit(1);
    if (!environment) throw notFound('environment');
    return { ...access, environment };
  }

  /** Projects of an organization this member may see. */
  async visibleProjects(access: OrgAccess): Promise<ProjectRow[]> {
    if (access.projectAccess === 'all') {
      return this.db
        .select()
        .from(projects)
        .where(eq(projects.organizationId, access.organizationId))
        .orderBy(projects.name);
    }
    const rows = await this.db
      .select({ project: projects })
      .from(projects)
      .innerJoin(membershipProjects, eq(membershipProjects.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, access.organizationId),
          eq(membershipProjects.membershipId, access.membershipId),
        ),
      )
      .orderBy(projects.name);
    return rows.map((r) => r.project);
  }

  requirePlatformAdmin(user: SessionUser): void {
    if (user.platformRole !== 'admin')
      throw new ApiError('forbidden', 'platform operator access required');
  }
}
