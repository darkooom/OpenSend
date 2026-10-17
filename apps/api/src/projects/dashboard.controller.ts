import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Permission } from '@opensend/contracts';
import type { Response } from 'express';
import { AccessService } from '../access/access.service';
import { ClientIp, CurrentUser, SessionGuard, type SessionUser } from '../auth/guards';
import { ConnectionsService } from '../connections/connections.service';
import { DomainsService } from '../domains/domains.service';
import { AcceptanceService } from '../emails/acceptance.service';
import { EmailActionsService } from '../emails/email-actions.service';
import { EmailQueryService } from '../emails/email-query.service';
import { ApiKeysService } from '../keys/api-keys.service';
import { SuppressionsService } from '../suppressions/suppressions.service';
import { TemplatesService } from '../templates/templates.service';
import { UsageService } from '../usage/usage.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ProjectsService } from './projects.service';

/**
 * Session-authenticated management API used by the dashboard. Every handler resolves
 * access through AccessService before touching data.
 */
@Controller('api')
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(
    private readonly access: AccessService,
    private readonly projects: ProjectsService,
    private readonly keys: ApiKeysService,
    private readonly connections: ConnectionsService,
    private readonly domains: DomainsService,
    private readonly templates: TemplatesService,
    private readonly webhooks: WebhooksService,
    private readonly suppressions: SuppressionsService,
    private readonly query: EmailQueryService,
    private readonly actions: EmailActionsService,
    private readonly acceptance: AcceptanceService,
    private readonly usage: UsageService,
  ) {}

  private env(u: SessionUser, p: string, e: string, perm: Permission) {
    return this.access.requireEnvironment(u, p, e, perm);
  }

  /* ------------------------------ organization ------------------------------ */

  @Get('orgs/:orgId/audit')
  async orgAudit(
    @CurrentUser() u: SessionUser,
    @Param('orgId') orgId: string,
    @Query('projectId') projectId?: string,
    @Query('before') before?: string,
  ) {
    const a = await this.access.requireOrg(u, orgId, 'audit.read');
    return this.projects.audit(a, { projectId, before });
  }

  /* -------------------------------- projects -------------------------------- */

  @Get('projects/:p')
  async project(@CurrentUser() u: SessionUser, @Param('p') p: string) {
    return this.projects.get(await this.access.requireProject(u, p, 'project.read'));
  }

  @Patch('projects/:p')
  async rename(@CurrentUser() u: SessionUser, @Param('p') p: string, @Body() body: unknown) {
    return this.projects.rename(await this.access.requireProject(u, p, 'project.manage'), u, body);
  }

  @Patch('projects/:p/retention')
  async retention(@CurrentUser() u: SessionUser, @Param('p') p: string, @Body() body: unknown) {
    return this.projects.setRetention(
      await this.access.requireProject(u, p, 'retention.manage'),
      u,
      body,
    );
  }

  @Post('projects/:p/environments')
  async createEnv(@CurrentUser() u: SessionUser, @Param('p') p: string, @Body() body: unknown) {
    return this.projects.createEnvironment(
      await this.access.requireProject(u, p, 'environments.manage'),
      u,
      body,
    );
  }

  @Get('projects/:p/usage')
  async projectUsage(@CurrentUser() u: SessionUser, @Param('p') p: string) {
    const a = await this.access.requireProject(u, p, 'usage.read');
    return this.usage.get(a.project.id, null);
  }

  /* --------------------------- environment scoped --------------------------- */

  @Get('projects/:p/environments/:e/overview')
  async overview(@CurrentUser() u: SessionUser, @Param('p') p: string, @Param('e') e: string) {
    return this.projects.overview(await this.env(u, p, e, 'project.read'));
  }

  @Get('projects/:p/environments/:e/export')
  async export(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Res() res: Response,
  ) {
    const a = await this.env(u, p, e, 'export.run');
    await this.projects.export(a, u, res);
  }

  // emails
  @Get('projects/:p/environments/:e/emails')
  async emails(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Query() q: Record<string, string>,
  ) {
    const a = await this.env(u, p, e, 'emails.read');
    return this.query.list({ projectId: a.project.id, environmentId: a.environment.id }, q);
  }

  @Get('projects/:p/environments/:e/emails/:id')
  async email(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    const a = await this.env(u, p, e, 'emails.read');
    return this.query.detail({ projectId: a.project.id, environmentId: a.environment.id }, id);
  }

  @Get('projects/:p/environments/:e/emails/:id/content')
  async emailContent(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const a = await this.env(u, p, e, 'emails.read_content');
    res.setHeader('Cache-Control', 'no-store');
    return this.actions.content({ projectId: a.project.id, environmentId: a.environment.id }, id);
  }

  @Get('projects/:p/environments/:e/emails/:id/attachments/:attachmentId')
  async attachment(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const a = await this.env(u, p, e, 'emails.read_content');
    const file = await this.actions.attachment(
      { projectId: a.project.id, environmentId: a.environment.id },
      id,
      attachmentId,
    );
    // Always a download, never rendered inline in the dashboard origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(file.body);
  }

  @Post('projects/:p/environments/:e/emails/:id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @ClientIp() ip: string | null,
  ) {
    const a = await this.env(u, p, e, 'emails.cancel');
    return this.actions.cancel({ projectId: a.project.id, environmentId: a.environment.id }, id, {
      type: 'user',
      id: u.id,
      organizationId: a.organizationId,
      ip,
    });
  }

  @Post('projects/:p/environments/:e/emails/:id/resend')
  @HttpCode(202)
  async resend(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    const a = await this.env(u, p, e, 'emails.resend');
    return this.actions.resend(
      { projectId: a.project.id, environmentId: a.environment.id },
      id,
      body,
      { type: 'user', id: u.id, organizationId: a.organizationId, ip },
    );
  }

  /** Dashboard "send test email" — same acceptance pipeline as the public API. */
  @Post('projects/:p/environments/:e/test-email')
  @HttpCode(202)
  async testEmail(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
  ) {
    const a = await this.env(u, p, e, 'emails.send');
    const r = await this.acceptance.accept(
      { projectId: a.project.id, environmentId: a.environment.id, userId: u.id },
      body,
    );
    return r.body;
  }

  // api keys
  @Get('projects/:p/environments/:e/api-keys')
  async listKeys(@CurrentUser() u: SessionUser, @Param('p') p: string, @Param('e') e: string) {
    return this.keys.list(await this.env(u, p, e, 'api_keys.manage'));
  }

  @Post('projects/:p/environments/:e/api-keys')
  async createKey(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.keys.create(await this.env(u, p, e, 'api_keys.manage'), u, body, ip);
  }

  @Delete('projects/:p/environments/:e/api-keys/:id')
  @HttpCode(204)
  async revokeKey(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @ClientIp() ip: string | null,
  ) {
    await this.keys.revoke(await this.env(u, p, e, 'api_keys.manage'), u, id, ip);
  }

  // provider connections
  @Get('projects/:p/environments/:e/providers')
  async listConnections(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
  ) {
    return this.connections.list(await this.env(u, p, e, 'providers.read'));
  }

  @Post('projects/:p/environments/:e/providers')
  async createConnection(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.connections.create(await this.env(u, p, e, 'providers.manage'), u, body, ip);
  }

  @Patch('projects/:p/environments/:e/providers/:id')
  async updateConnection(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.connections.update(await this.env(u, p, e, 'providers.manage'), u, id, body, ip);
  }

  @Post('projects/:p/environments/:e/providers/:id/test')
  @HttpCode(200)
  async testConnection(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    return this.connections.test(await this.env(u, p, e, 'providers.manage'), id);
  }

  @Delete('projects/:p/environments/:e/providers/:id')
  @HttpCode(204)
  async deleteConnection(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @ClientIp() ip: string | null,
  ) {
    await this.connections.remove(await this.env(u, p, e, 'providers.manage'), u, id, ip);
  }

  // domains
  private domainScope(a: Awaited<ReturnType<AccessService['requireEnvironment']>>) {
    return {
      organizationId: a.organizationId,
      projectId: a.project.id,
      environmentId: a.environment.id,
      environmentKind: a.environment.kind,
    };
  }

  @Get('projects/:p/environments/:e/domains')
  async listDomains(@CurrentUser() u: SessionUser, @Param('p') p: string, @Param('e') e: string) {
    return this.domains.list(this.domainScope(await this.env(u, p, e, 'domains.read')));
  }

  @Post('projects/:p/environments/:e/domains')
  async createDomain(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.domains.create(this.domainScope(await this.env(u, p, e, 'domains.manage')), body, {
      type: 'user',
      id: u.id,
      ip,
    });
  }

  @Post('projects/:p/environments/:e/domains/:id/verify')
  @HttpCode(200)
  async verifyDomain(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    return this.domains.verify(this.domainScope(await this.env(u, p, e, 'domains.manage')), id);
  }

  @Delete('projects/:p/environments/:e/domains/:id')
  @HttpCode(204)
  async deleteDomain(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @ClientIp() ip: string | null,
  ) {
    await this.domains.remove(this.domainScope(await this.env(u, p, e, 'domains.manage')), id, {
      type: 'user',
      id: u.id,
      ip,
    });
  }

  // templates
  @Get('projects/:p/environments/:e/templates')
  async listTemplates(@CurrentUser() u: SessionUser, @Param('p') p: string, @Param('e') e: string) {
    return this.templates.list(await this.env(u, p, e, 'templates.read'));
  }

  @Post('projects/:p/environments/:e/templates')
  async createTemplate(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
  ) {
    return this.templates.create(await this.env(u, p, e, 'templates.manage'), u, body);
  }

  @Get('projects/:p/environments/:e/templates/:id')
  async getTemplate(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    return this.templates.get(await this.env(u, p, e, 'templates.read'), id);
  }

  @Patch('projects/:p/environments/:e/templates/:id')
  async updateTemplate(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.templates.update(await this.env(u, p, e, 'templates.manage'), body, id);
  }

  @Post('projects/:p/environments/:e/templates/:id/publish')
  async publishTemplate(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    return this.templates.publish(await this.env(u, p, e, 'templates.manage'), u, id);
  }

  @Post('projects/:p/environments/:e/templates/:id/preview')
  @HttpCode(200)
  async previewTemplate(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.templates.preview(await this.env(u, p, e, 'templates.read'), id, body);
  }

  @Delete('projects/:p/environments/:e/templates/:id')
  @HttpCode(204)
  async deleteTemplate(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    await this.templates.remove(await this.env(u, p, e, 'templates.manage'), u, id);
  }

  // webhooks
  @Get('projects/:p/environments/:e/webhooks')
  async listWebhooks(@CurrentUser() u: SessionUser, @Param('p') p: string, @Param('e') e: string) {
    return this.webhooks.list(await this.env(u, p, e, 'webhooks.manage'));
  }

  @Post('projects/:p/environments/:e/webhooks')
  async createWebhook(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
  ) {
    return this.webhooks.create(await this.env(u, p, e, 'webhooks.manage'), u, body);
  }

  @Patch('projects/:p/environments/:e/webhooks/:id')
  async updateWebhook(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.webhooks.update(await this.env(u, p, e, 'webhooks.manage'), u, id, body);
  }

  @Post('projects/:p/environments/:e/webhooks/:id/rotate-secret')
  async rotateWebhook(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    return this.webhooks.rotate(await this.env(u, p, e, 'webhooks.manage'), u, id);
  }

  @Post('projects/:p/environments/:e/webhooks/:id/test')
  @HttpCode(202)
  async testWebhook(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    return this.webhooks.test(await this.env(u, p, e, 'webhooks.manage'), id);
  }

  @Get('projects/:p/environments/:e/webhooks/:id/deliveries')
  async webhookDeliveries(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    return this.webhooks.deliveries(await this.env(u, p, e, 'webhooks.manage'), id, status);
  }

  @Get('projects/:p/environments/:e/webhook-deliveries/dead')
  async deadLetters(@CurrentUser() u: SessionUser, @Param('p') p: string, @Param('e') e: string) {
    return this.projects.deadLetters(await this.env(u, p, e, 'webhooks.manage'));
  }

  @Get('projects/:p/environments/:e/webhook-deliveries/:deliveryId/attempts')
  async deliveryAttempts(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('deliveryId') id: string,
  ) {
    return this.webhooks.deliveryAttempts(await this.env(u, p, e, 'webhooks.manage'), id);
  }

  @Post('projects/:p/environments/:e/webhook-deliveries/:deliveryId/replay')
  @HttpCode(202)
  async replay(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('deliveryId') id: string,
  ) {
    return this.webhooks.replay(await this.env(u, p, e, 'webhooks.manage'), u, id);
  }

  @Delete('projects/:p/environments/:e/webhooks/:id')
  @HttpCode(204)
  async deleteWebhook(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    await this.webhooks.remove(await this.env(u, p, e, 'webhooks.manage'), u, id);
  }

  // suppressions
  @Get('projects/:p/environments/:e/suppressions')
  async listSuppressions(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Query('q') q?: string,
  ) {
    return this.suppressions.list(await this.env(u, p, e, 'emails.read'), q);
  }

  @Post('projects/:p/environments/:e/suppressions')
  async addSuppression(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Body() body: unknown,
  ) {
    return this.suppressions.add(await this.env(u, p, e, 'suppressions.manage'), u, body);
  }

  @Delete('projects/:p/environments/:e/suppressions/:id')
  @HttpCode(204)
  async removeSuppression(
    @CurrentUser() u: SessionUser,
    @Param('p') p: string,
    @Param('e') e: string,
    @Param('id') id: string,
  ) {
    await this.suppressions.remove(await this.env(u, p, e, 'suppressions.manage'), u, id);
  }
}
