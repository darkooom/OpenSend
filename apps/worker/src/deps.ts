import type { AppConfig } from '@opensend/config';
import type { KeyRing, Logger, ObjectStore } from '@opensend/core';
import type { Database } from '@opensend/db';
import type { ProviderFactory } from '@opensend/providers';

export interface WorkerDeps {
  db: Database;
  config: AppConfig;
  keys: KeyRing;
  store: ObjectStore;
  providers: ProviderFactory;
  logger: Logger;
  /** Unique id of this worker process (lease owner). */
  workerId: string;
}

export const QUEUES = {
  send_email: 'opensend-send',
  deliver_webhook: 'opensend-webhooks',
  process_provider_event: 'opensend-provider-events',
} as const;
export type JobKind = keyof typeof QUEUES;

export interface JobPayload {
  outboxId: number;
  refId: string;
}
