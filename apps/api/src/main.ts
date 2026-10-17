import { parseConfig } from '@opensend/config';
import { createApp } from './app';

async function main() {
  const config = parseConfig();
  const app = await createApp({ config });
  await app.listen(config.API_PORT, config.API_HOST);
  console.warn(`[opensend-api] listening on http://${config.API_HOST}:${config.API_PORT}`);
}

main().catch((err: unknown) => {
  console.error('[opensend-api] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
