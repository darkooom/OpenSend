/** Connection settings for the integration test stack (docker-compose services). */
export const IT = {
  adminDatabaseUrl:
    process.env.IT_ADMIN_DATABASE_URL ?? 'postgres://opensend:opensend@localhost:54329/postgres',
  databaseName: process.env.IT_DATABASE_NAME ?? 'opensend_it',
  get databaseUrl() {
    const u = new URL(this.adminDatabaseUrl);
    u.pathname = `/${this.databaseName}`;
    return u.toString();
  },
  redisUrl: process.env.IT_REDIS_URL ?? 'redis://localhost:56379/15',
  mailpitSmtpHost: process.env.MAILPIT_SMTP_HOST ?? '127.0.0.1',
  mailpitSmtpPort: Number(process.env.MAILPIT_SMTP_PORT ?? 51025),
  mailpitApiUrl: process.env.MAILPIT_API_URL ?? 'http://localhost:58025',
};
