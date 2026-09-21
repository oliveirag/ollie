import { stringify } from 'yaml';
import { buildConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { OPENAPI_HEADER, pruneUnreferencedSchemas, toOpenApi30 } from '../openapiDocument.js';
import { MockBrokerAdapter } from '../orchestrator/robinhood/mockClient.js';
import { buildApp } from './app.js';

export { OPENAPI_HEADER, pruneUnreferencedSchemas, toOpenApi30 };

/**
 * A token is required to build the app, and generating a spec should not
 * require possession of the production credential. This placeholder never
 * authenticates anything: it exists only so route registration can proceed.
 */
const SPEC_ONLY_TOKEN = 'x'.repeat(64);

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

export async function renderOpenApiYaml(): Promise<string> {
  const config = {
    ...buildConfig({ ...process.env, OWNER_API_TOKEN: SPEC_ONLY_TOKEN }),
    ownerApiToken: SPEC_ONLY_TOKEN,
  };

  // The mock adapter never opens a connection; rendering a document should not
  // require broker credentials, or reach the network at all.
  const app = await buildApp({
    config,
    logger: logger.child({ component: 'openapi' }),
    broker: new MockBrokerAdapter(),
  });
  try {
    await app.ready();
    const document = app.swagger() as Record<string, unknown>;
    // Order matters: prune before converting, so the reachability walk sees the
    // `anyOf` refs in the shape it was written against.
    pruneUnreferencedSchemas(document);
    toOpenApi30(document);
    // `lineWidth: 0` disables folding: a wrapped description produces a diff
    // that moves when unrelated text changes length, which is noise in review.
    return OPENAPI_HEADER + stringify(document, { lineWidth: 0 });
  } finally {
    await app.close();
  }
}
