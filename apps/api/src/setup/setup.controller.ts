import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ClientIp } from '../auth/guards';
import { PLATFORM_MAILER } from '../infra/tokens';
import type { PlatformMailer } from '../mail/platform-mailer';
import { SetupService } from './setup.service';

@Controller('api/setup')
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    @Inject(PLATFORM_MAILER) private readonly mailer: PlatformMailer,
  ) {}

  @Get('status')
  async status() {
    // `accountEmails` tells the dashboard whether password reset / verification can be offered.
    return { needsSetup: await this.setup.needsSetup(), accountEmails: this.mailer.enabled };
  }

  @Post()
  @HttpCode(201)
  complete(@Body() body: unknown, @ClientIp() ip: string | null) {
    return this.setup.complete(body, ip);
  }
}
