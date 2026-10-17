import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '@opensend/config';
import type { Database } from '@opensend/db';
import { AUTH, CONFIG, DB } from '../infra/tokens';
import { createAuth } from './auth';

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Database, config: AppConfig) => createAuth(db, config),
      inject: [DB, CONFIG],
    },
  ],
  exports: [AUTH],
})
export class AuthModule {}
