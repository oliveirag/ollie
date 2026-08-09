import { stringify } from 'yaml';
import { buildConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { buildApp } from './app.js';

/**
 * Render the OpenAPI document from the live route definitions.
 *
 * `docs/openapi.yaml` is the cross-language contract (PRD §5) and it is a
 * generated artifact, not a hand-authored one. The alternative — writing the
 * YAML by hand and diffing it against what Fastify emits — fails on key order
 * and `$ref` naming rather than on real drift, and a test that cries wolf gets
 * muted. Here the zod schemas are the single authoring surface, the YAML is
 * checked in for the Swift generator to consume, and the drift test proves the
 * two agree.
 */

export const OPENAPI_HEADER = `# Generated from the zod route schemas. Do not edit by hand.
#
# Regenerate with:  npm run openapi:write
# The drift test (test/openapi.drift.test.ts) fails if this file falls behind
# the routes, which is how a Swift client and a Node handler stay in sync.
`;

/**
 * A token is required to build the app, and generating a spec should not
 * require possession of the production credential. This placeholder never
 * authenticates anything: it exists only so route registration can proceed.
 */
const SPEC_ONLY_TOKEN = 'x'.repeat(64);

const REF_PREFIX = '#/components/schemas/';

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
      into.add(value.slice(REF_PREFIX.length));
    } else {
      collectRefs(value, into);
    }
  }
}

/**
 * Drop `components.schemas` entries nothing references.
 *
 * The transform emits an input and an output variant of every registered
 * schema, because a schema used in a request body can legitimately differ from
 * the same schema used in a response. Only one variant is usually reachable,
 * and the other is not merely noise: `swift-openapi-generator` emits a Swift
 * type per component, so an unreferenced half of the registry becomes dead
 * types in the app. Pruning is transitive — a kept schema's own refs are
 * followed — so adding a request body in a later milestone brings its input
 * variant back automatically.
 */
export function pruneUnreferencedSchemas(document: Record<string, unknown>): void {
  const components = document.components as { schemas?: Record<string, unknown> } | undefined;
  const schemas = components?.schemas;
  if (!schemas) return;

  const { schemas: _omitted, ...componentsWithoutSchemas } = components as Record<string, unknown>;
  const reachable = new Set<string>();
  collectRefs({ ...document, components: componentsWithoutSchemas }, reachable);

  // Fixpoint: a reachable schema may reference others.
  const queue = [...reachable];
  while (queue.length > 0) {
    const name = queue.pop()!;
    const schema = schemas[name];
    if (!schema) continue;
    const nested = new Set<string>();
    collectRefs(schema, nested);
    for (const ref of nested) {
      if (!reachable.has(ref)) {
        reachable.add(ref);
        queue.push(ref);
      }
    }
  }

  for (const name of Object.keys(schemas)) {
    if (!reachable.has(name)) delete schemas[name];
  }
}

export async function renderOpenApiYaml(): Promise<string> {
  const config = {
    ...buildConfig({ ...process.env, OWNER_API_TOKEN: SPEC_ONLY_TOKEN }),
    ownerApiToken: SPEC_ONLY_TOKEN,
  };

  const app = await buildApp({ config, logger: logger.child({ component: 'openapi' }) });
  try {
    await app.ready();
    const document = app.swagger() as Record<string, unknown>;
    pruneUnreferencedSchemas(document);
    // `lineWidth: 0` disables folding: a wrapped description produces a diff
    // that moves when unrelated text changes length, which is noise in review.
    return OPENAPI_HEADER + stringify(document, { lineWidth: 0 });
  } finally {
    await app.close();
  }
}
