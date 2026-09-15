/**
 * Write docs/disclaimer.md from the DISCLAIMER_TEXT constant.
 *
 *   npm run disclaimer:write
 *
 * The constant is the source because it has to ship inside the deployable;
 * the markdown exists so the words are reviewable next to the plan. The
 * drift test fails until the two agree.
 */
import { writeFile } from 'node:fs/promises';
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION } from '../src/published/disclaimer.js';
import { DISCLAIMER_PATH } from '../src/server/paths.js';

async function main(): Promise<void> {
  await writeFile(DISCLAIMER_PATH, DISCLAIMER_TEXT, 'utf8');
  console.log(`wrote ${DISCLAIMER_PATH} (version ${DISCLAIMER_VERSION})`);
}

main().catch((error: unknown) => {
  console.error('write-disclaimer failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
