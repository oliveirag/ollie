/**
 * Regenerate both OpenAPI documents from their route schemas.
 *
 *   npm run openapi:write
 *
 * Run this after changing any route schema. The drift tests fail until you
 * do, which is deliberate: the contracts the Swift clients generate from
 * should never be something a backend change quietly invalidated.
 */
import { writeFile } from 'node:fs/promises';
import { OPENAPI_PATH, OPENAPI_SUBSCRIBER_PATH } from '../src/server/paths.js';
import { renderOpenApiYaml } from '../src/server/openapi.js';
import { renderSubscriberOpenApiYaml } from '../src/signal-server/openapi.js';

async function main(): Promise<void> {
  const owner = await renderOpenApiYaml();
  await writeFile(OPENAPI_PATH, owner, 'utf8');
  console.log(`wrote ${OPENAPI_PATH} (${owner.split('\n').length} lines)`);

  const subscriber = await renderSubscriberOpenApiYaml();
  await writeFile(OPENAPI_SUBSCRIBER_PATH, subscriber, 'utf8');
  console.log(`wrote ${OPENAPI_SUBSCRIBER_PATH} (${subscriber.split('\n').length} lines)`);
}

main().catch((error: unknown) => {
  console.error('write-openapi failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
