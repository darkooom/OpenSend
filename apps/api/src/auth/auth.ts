import type { AppConfig } from '@opensend/config';
import { account, session, user, verification, type Database } from '@opensend/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { accountEmails, type PlatformMailer } from '../mail/platform-mailer';

/**
 * The single authentication system for dashboard users (Better Auth, email + password).
 * Public sign-up is disabled: users are created by the one-time owner bootstrap or by
 * accepting an invitation (see SetupService / OrgsService). Password reset and email
 * verification are only offered when the operator configured a platform sender.
 */
export function createAuth(db: Database, config: AppConfig, mailer: PlatformMailer) {
  const production = config.NODE_ENV === 'production';
  return betterAuth({
    appName: 'OpenSend',
    baseURL: config.PUBLIC_WEB_URL,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(config.PUBLIC_WEB_URL).origin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(mailer.enabled
        ? {
            sendResetPassword: async ({
              user: u,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              await mailer.send(accountEmails.passwordReset({ to: u.email, url }));
            },
          }
        : {}),
    },
    ...(mailer.enabled
      ? {
          emailVerification: {
            expiresIn: 60 * 60 * 24,
            autoSignInAfterVerification: false,
            sendVerificationEmail: async ({
              user: u,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              await mailer.send(accountEmails.verification({ to: u.email, url }));
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        platformRole: { type: 'string', required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: config.NODE_ENV !== 'test', window: 60, max: 30 },
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: 'opensend',
      useSecureCookies: production,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: production },
      ipAddress: { ipAddressHeaders: config.TRUST_PROXY ? ['x-forwarded-for'] : [] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Create a credential user without the (disabled) public sign-up endpoint. */
export async function createCredentialUser(
  auth: Auth,
  input: { email: string; name: string; password: string },
) {
  const ctx = await auth.$context;
  if (input.password.length < 12) throw new Error('password must be at least 12 characters');
  const hash = await ctx.password.hash(input.password);
  const created = await ctx.internalAdapter.createUser(
    { email: input.email.toLowerCase(), name: input.name, emailVerified: false },
    { method: 'email-password' } as never,
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: hash,
  });
  return created;
}
