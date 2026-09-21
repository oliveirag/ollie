import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo-relative paths resolved from this module's own location, so the spec
 * writer and the drift test agree on one file regardless of which directory
 * either was invoked from.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** backend/src/server -> repo root */
export const REPO_ROOT = resolve(here, '../../..');

export const OPENAPI_PATH = resolve(REPO_ROOT, 'docs/openapi.yaml');
export const OPENAPI_SUBSCRIBER_PATH = resolve(REPO_ROOT, 'docs/openapi-subscriber.yaml');
export const DISCLAIMER_PATH = resolve(REPO_ROOT, 'docs/disclaimer.md');
