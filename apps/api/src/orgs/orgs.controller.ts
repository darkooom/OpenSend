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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClientIp, CurrentUser, SessionGuard, type SessionUser } from '../auth/guards';
import { OrgsService } from './orgs.service';

@Controller('api')
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() u: SessionUser) {
    return this.orgs.me(u);
  }

  @Post('orgs')
  @UseGuards(SessionGuard)
  createOrg(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    return this.orgs.createOrg(u, body);
  }

  @Get('orgs/:orgId')
  @UseGuards(SessionGuard)
  getOrg(@CurrentUser() u: SessionUser, @Param('orgId') orgId: string) {
    return this.orgs.getOrg(u, orgId);
  }

  @Post('orgs/:orgId/projects')
  @UseGuards(SessionGuard)
  createProject(
    @CurrentUser() u: SessionUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    return this.orgs.createProject(u, orgId, body);
  }

  @Get('orgs/:orgId/members')
  @UseGuards(SessionGuard)
  members(@CurrentUser() u: SessionUser, @Param('orgId') orgId: string) {
    return this.orgs.listMembers(u, orgId);
  }

  @Patch('orgs/:orgId/members/:membershipId')
  @UseGuards(SessionGuard)
  updateMember(
    @CurrentUser() u: SessionUser,
    @Param('orgId') orgId: string,
    @Param('membershipId') id: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.orgs.updateMember(u, orgId, id, body, ip);
  }

  @Delete('orgs/:orgId/members/:membershipId')
  @UseGuards(SessionGuard)
  @HttpCode(204)
  async removeMember(
    @CurrentUser() u: SessionUser,
    @Param('orgId') orgId: string,
    @Param('membershipId') id: string,
    @ClientIp() ip: string | null,
  ) {
    await this.orgs.removeMember(u, orgId, id, ip);
  }

  @Get('orgs/:orgId/invitations')
  @UseGuards(SessionGuard)
  invitations(@CurrentUser() u: SessionUser, @Param('orgId') orgId: string) {
    return this.orgs.listInvitations(u, orgId);
  }

  @Post('orgs/:orgId/invitations')
  @UseGuards(SessionGuard)
  invite(
    @CurrentUser() u: SessionUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
    @ClientIp() ip: string | null,
  ) {
    return this.orgs.invite(u, orgId, body, ip);
  }

  @Delete('orgs/:orgId/invitations/:invitationId')
  @UseGuards(SessionGuard)
  @HttpCode(204)
  async revoke(
    @CurrentUser() u: SessionUser,
    @Param('orgId') orgId: string,
    @Param('invitationId') id: string,
    @ClientIp() ip: string | null,
  ) {
    await this.orgs.revokeInvitation(u, orgId, id, ip);
  }

  /* Public invitation endpoints (token is the credential). */
  @Get('invitations/lookup')
  lookup(@Query('token') token: string) {
    return this.orgs.lookupInvitation(token);
  }

  @Post('invitations/accept')
  accept(@Body() body: unknown, @Req() req: Request, @ClientIp() ip: string | null) {
    return this.orgs.acceptInvitation(body, req.headers, ip);
  }
}
