export type {
  DomainResource,
  EmailListItem,
  EmailResource,
  UsageResponse,
  DnsRecord,
} from '@opensend/contracts';

export interface Me {
  user: { id: string; email: string; name: string; platformRole: 'admin' | null };
  memberships: Array<{
    organization: { id: string; name: string; slug: string };
    role: string;
    projectAccess: string;
  }>;
}

export interface Environment {
  id: string;
  name: string;
  kind: 'development' | 'staging' | 'production';
  createdAt?: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  role?: string;
  retention: { contentDays: number; attachmentDays: number; eventDays: number };
  monthlyRecipientQuota: number;
  paused: { at: string; reason: string | null } | null;
  environments: Environment[];
}

export interface OrgDetail {
  organization: { id: string; name: string; slug: string };
  role: string;
  projectAccess: string;
  projects: Project[];
}
