import type { TargetPolicy } from '@opensend/core';
import { LocalMailpitAdapter, SmtpAdapter, smtpConfigSchema, smtpSecretsSchema } from './smtp';
import { SesAdapter, sesConfigSchema, sesSecretsSchema } from './ses';
import type { ProviderAdapter, ProviderCapabilities } from './types';

export * from './types';
export * from './smtp';
export * from './ses';
export * from './sns';

export interface ProviderRuntime {
  timeoutMs: number;
  policy: TargetPolicy;
  localEnabled: boolean;
  mailpit: { smtpHost: string; smtpPort: number; apiUrl: string };
}

export interface ConnectionSpec {
  type: 'local' | 'smtp' | 'ses';
  config: unknown;
  secrets: unknown;
}

export class ProviderConfigError extends Error {}

export const PROVIDER_CAPABILITIES: Record<ConnectionSpec['type'], ProviderCapabilities> = {
  local: { send: true, domainVerification: false, deliveryEvents: false, statusLookup: true },
  smtp: { send: true, domainVerification: false, deliveryEvents: false, statusLookup: false },
  ses: { send: true, domainVerification: true, deliveryEvents: true, statusLookup: false },
};

/** Validate tenant-supplied connection settings. Returns normalized config and secrets. */
export function validateConnection(
  type: ConnectionSpec['type'],
  config: unknown,
  secrets: unknown,
) {
  switch (type) {
    case 'local':
      return { config: {}, secrets: {} };
    case 'smtp':
      return {
        config: smtpConfigSchema.parse(config),
        secrets: smtpSecretsSchema.parse(secrets ?? {}),
      };
    case 'ses':
      return { config: sesConfigSchema.parse(config), secrets: sesSecretsSchema.parse(secrets) };
  }
}

export function createProviderAdapter(spec: ConnectionSpec, rt: ProviderRuntime): ProviderAdapter {
  switch (spec.type) {
    case 'local':
      if (!rt.localEnabled)
        throw new ProviderConfigError(
          'the local development provider is disabled on this instance',
        );
      return new LocalMailpitAdapter({
        timeoutMs: rt.timeoutMs,
        policy: rt.policy,
        smtpHost: rt.mailpit.smtpHost,
        smtpPort: rt.mailpit.smtpPort,
        apiUrl: rt.mailpit.apiUrl,
      });
    case 'smtp':
      return new SmtpAdapter(
        smtpConfigSchema.parse(spec.config),
        smtpSecretsSchema.parse(spec.secrets ?? {}),
        {
          timeoutMs: rt.timeoutMs,
          policy: rt.policy,
        },
      );
    case 'ses':
      return new SesAdapter(
        sesConfigSchema.parse(spec.config),
        sesSecretsSchema.parse(spec.secrets),
        { timeoutMs: rt.timeoutMs },
      );
  }
}

export type ProviderFactory = (spec: ConnectionSpec) => ProviderAdapter;
