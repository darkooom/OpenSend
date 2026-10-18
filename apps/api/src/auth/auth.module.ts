import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import type { Database } from '@opensend/db';
import { AUTH, CONFIG, DB, PLATFORM_MAILER } from '../infra/tokens';
import type { PlatformMailer } from '../mail/platform-mailer';
import { createAuth } from './auth';

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Database, config: AppConfig, mailer: PlatformMailer) =>
        createAuth(db, config, mailer),
      inject: [DB, CONFIG, PLATFORM_MAILER],
    },
  ],
  exports: [AUTH],
})
export class AuthModule {}
