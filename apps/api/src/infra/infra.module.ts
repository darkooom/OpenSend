import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type AppConfig } from '@opensend/config';
import { KeyRing, S3ObjectStore, createLogger, type ObjectStore } from '@opensend/core';
import { createDb, type DbHandle } from '@opensend/db';
import {
  createProviderAdapter,
  type ConnectionSpec,
  type ProviderAdapter,
} from '@opensend/providers';
import Redis from 'ioredis';
import { systemDnsResolver } from './dns';
import {
  CONFIG,
  DB,
  DB_HANDLE,
  DNS_RESOLVER,
  KEYRING,
  LOGGER,
  OBJECT_STORE,
  PROVIDER_FACTORY,
  REDIS,
} from './tokens';

export type ProviderFactory = (spec: ConnectionSpec) => ProviderAdapter;

export interface InfraOverrides {
  config: AppConfig;
  objectStore?: ObjectStore;
  dnsResolver?: unknown;
  providerFactory?: ProviderFactory;
}

let overrides: InfraOverrides | undefined;
/** Must be called before the Nest app is created (main.ts / tests). */
export function configureInfra(o: InfraOverrides): void {
  overrides = o;
}
function required(): InfraOverrides {
  if (!overrides) throw new Error('configureInfra() was not called');
  return overrides;
}

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => required().config },
    {
      provide: DB_HANDLE,
      useFactory: (config: AppConfig) =>
        createDb(config.DATABASE_URL, { max: 20, applicationName: 'opensend-api' }),
      inject: [CONFIG],
    },
    { provide: DB, useFactory: (h: DbHandle) => h.db, inject: [DB_HANDLE] },
    {
      provide: KEYRING,
      useFactory: (c: AppConfig) =>
        KeyRing.fromEnv(c.OPENSEND_ENCRYPTION_KEYS, c.OPENSEND_ENCRYPTION_ACTIVE_KEY_ID),
      inject: [CONFIG],
    },
    {
      provide: OBJECT_STORE,
      useFactory: async (c: AppConfig) => {
        const o = required().objectStore;
        if (o) return o;
        const store = new S3ObjectStore({
          endpoint: c.S3_ENDPOINT,
          region: c.S3_REGION,
          bucket: c.S3_BUCKET,
          accessKeyId: c.S3_ACCESS_KEY_ID,
          secretAccessKey: c.S3_SECRET_ACCESS_KEY,
          forcePathStyle: c.S3_FORCE_PATH_STYLE,
        });
        if (c.NODE_ENV !== 'production') await store.ensureBucket();
        return store;
      },
      inject: [CONFIG],
    },
    {
      provide: REDIS,
      useFactory: (c: AppConfig) =>
        new Redis(c.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: false,
          connectTimeout: 2000,
        }),
      inject: [CONFIG],
    },
    {
      provide: LOGGER,
      useFactory: (c: AppConfig) => createLogger({ name: 'opensend-api', level: c.LOG_LEVEL }),
      inject: [CONFIG],
    },
    { provide: DNS_RESOLVER, useFactory: () => required().dnsResolver ?? systemDnsResolver },
    {
      provide: PROVIDER_FACTORY,
      useFactory: (c: AppConfig): ProviderFactory =>
        required().providerFactory ??
        ((spec) =>
          createProviderAdapter(spec, {
            timeoutMs: c.OPENSEND_PROVIDER_TIMEOUT_MS,
            policy: { privateHostAllowlist: c.OPENSEND_PRIVATE_NETWORK_ALLOWLIST },
            localEnabled: c.OPENSEND_LOCAL_PROVIDER_ENABLED,
            mailpit: {
              smtpHost: c.MAILPIT_SMTP_HOST,
              smtpPort: c.MAILPIT_SMTP_PORT,
              apiUrl: c.MAILPIT_API_URL,
            },
          })),
      inject: [CONFIG],
    },
  ],
  exports: [
    CONFIG,
    DB,
    DB_HANDLE,
    KEYRING,
    OBJECT_STORE,
    REDIS,
    LOGGER,
    DNS_RESOLVER,
    PROVIDER_FACTORY,
  ],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.db.close();
  }
}
