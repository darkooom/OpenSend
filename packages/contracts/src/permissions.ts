/**
 * Organization roles and their permissions. Project-level restriction is applied on top:
 * members with `projectAccess = "selected"` only see the projects explicitly granted.
 * See docs/SECURITY.md for the rendered matrix.
 */
export const ROLE = ['owner', 'admin', 'developer', 'viewer'] as const;
export type RoleName = (typeof ROLE)[number];

export const PERMISSIONS = [
  'org.read',
  'org.manage',
  'members.manage',
  'project.read',
  'project.create',
  'project.manage',
  'environments.manage',
  'emails.read',
  'emails.read_content',
  'emails.send',
  'emails.cancel',
  'emails.resend',
  'domains.read',
  'domains.manage',
  'providers.read',
  'providers.manage',
  'api_keys.manage',
  'templates.read',
  'templates.manage',
  'webhooks.manage',
  'suppressions.manage',
  'usage.read',
  'retention.manage',
  'export.run',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'org.read',
  'project.read',
  'emails.read',
  'domains.read',
  'providers.read',
  'templates.read',
  'usage.read',
];
const DEVELOPER: Permission[] = [
  ...VIEWER,
  'emails.read_content',
  'emails.send',
  'emails.cancel',
  'emails.resend',
  'domains.manage',
  'api_keys.manage',
  'templates.manage',
  'webhooks.manage',
  'suppressions.manage',
];
const ADMIN: Permission[] = [
  ...DEVELOPER,
  'members.manage',
  'project.create',
  'project.manage',
  'environments.manage',
  'providers.manage',
  'retention.manage',
  'export.run',
  'audit.read',
];
const OWNER: Permission[] = [...ADMIN, 'org.manage'];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, ReadonlySet<Permission>>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  developer: new Set(DEVELOPER),
  viewer: new Set(VIEWER),
};

export function roleHas(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

const RANK: Record<RoleName, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };
/** An actor may only grant roles at or below their own rank; only owners may grant owner. */
export function canGrantRole(actor: RoleName, target: RoleName): boolean {
  if (target === 'owner') return actor === 'owner';
  return RANK[actor] >= RANK[target] && roleHas(actor, 'members.manage');
}

/** API key scopes (independent of user roles). */
export const API_KEY_SCOPES = [
  'emails:send',
  'emails:read',
  'domains:read',
  'domains:manage',
  'usage:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEY_SCOPE_PRESETS: Record<'sending' | 'full', ApiKeyScope[]> = {
  sending: ['emails:send'],
  full: [...API_KEY_SCOPES],
};
