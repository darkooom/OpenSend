import { Controller, Get, Inject } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import { CONFIG } from '../infra/tokens';
import { buildOpenApi } from './openapi';

@Controller('v1')
export class OpenApiController {
  private doc: unknown;
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Get('openapi.json')
  get() {
    this.doc ??= buildOpenApi(this.config.PUBLIC_API_URL);
    return this.doc;
  }
}
