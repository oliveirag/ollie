/**
 * Regenerate docs/openapi.yaml from the route schemas.
 *
 *   npm run openapi:write
 *
 * Run this after changing any route schema. The drift test fails until you do,
 * which is deliberate: the contract the Swift client generates from should
 * never be something a backend change quietly invalidated.
 */
import { writeFile } from 'node:fs/promises';
import { OPENAPI_PATH } from '../src/server/paths.js';
import { renderOpenApiYaml } from '../src/server/openapi.js';

async function main(): Promise<void> {
  const yaml = await renderOpenApiYaml();
  await writeFile(OPENAPI_PATH, yaml, 'utf8');
  console.log(`wrote ${OPENAPI_PATH} (${yaml.split('\n').length} lines)`);
}

main().catch((error: unknown) => {
  console.error('write-openapi failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
