import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ClientIp } from '../auth/guards';
import { SetupService } from './setup.service';

@Controller('api/setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  async status() {
    return { needsSetup: await this.setup.needsSetup() };
  }

  @Post()
  @HttpCode(201)
  complete(@Body() body: unknown, @ClientIp() ip: string | null) {
    return this.setup.complete(body, ip);
  }
}
