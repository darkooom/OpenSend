import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccessService } from './access/access.service';
import { AdminController } from './admin/admin.controller';
import { AuthModule } from './auth/auth.module';
import { ApiKeyGuard, SessionGuard } from './auth/guards';
import { ErrorFilter } from './common/error.filter';
import { RateLimitService } from './common/rate-limit.service';
import { ConnectionsService } from './connections/connections.service';
import { DomainsService } from './domains/domains.service';
import { AcceptanceService } from './emails/acceptance.service';
import { EmailActionsService } from './emails/email-actions.service';
import { EmailQueryService } from './emails/email-query.service';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { SNS_CERT_FETCHER, SesEventsController } from './ingest/ses-events.controller';
import { ApiKeysService } from './keys/api-keys.service';
import { OpenApiController } from './openapi/openapi.controller';
import { OrgsController } from './orgs/orgs.controller';
import { OrgsService } from './orgs/orgs.service';
import { DashboardController } from './projects/dashboard.controller';
import { DeletionService } from './projects/deletion.service';
import { ProjectsService } from './projects/projects.service';
import { PublicController } from './public/public.controller';
import { SetupController } from './setup/setup.controller';
import { SetupService } from './setup/setup.service';
import { SuppressionsService } from './suppressions/suppressions.service';
import { TemplatesService } from './templates/templates.service';
import { UsageService } from './usage/usage.service';
import { WebhooksService } from './webhooks/webhooks.service';
import { defaultCertFetcher, type CertFetcher } from '@opensend/providers';

let certFetcherOverride: CertFetcher | null = null;
/** Tests inject a fake certificate fetcher for SNS signature verification. */
export function setSnsCertFetcher(f: CertFetcher | null): void {
  certFetcherOverride = f;
}

@Module({
  imports: [InfraModule, AuthModule],
  controllers: [
    HealthController,
    OpenApiController,
    SetupController,
    OrgsController,
    DashboardController,
    PublicController,
    AdminController,
    SesEventsController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    // Resolved at call time so tests can swap the fetcher after the app started.
    {
      provide: SNS_CERT_FETCHER,
      useFactory: (): CertFetcher => (url) => (certFetcherOverride ?? defaultCertFetcher)(url),
    },
    SessionGuard,
    ApiKeyGuard,
    AccessService,
    RateLimitService,
    SetupService,
    OrgsService,
    ProjectsService,
    DeletionService,
    ApiKeysService,
    ConnectionsService,
    DomainsService,
    TemplatesService,
    WebhooksService,
    SuppressionsService,
    UsageService,
    AcceptanceService,
    EmailQueryService,
    EmailActionsService,
  ],
})
export class AppModule {}
