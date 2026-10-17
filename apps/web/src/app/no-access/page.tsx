import { AuthCard } from '@/components/auth-card';

export default function NoAccess() {
  return (
    <AuthCard
      title="No organization yet"
      description="Your account is not a member of any organization. Ask an owner or admin to invite you."
    >
      {null}
    </AuthCard>
  );
}
