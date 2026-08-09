import { stringify } from 'yaml';
import { buildConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { MockBrokerAdapter } from '../orchestrator/robinhood/mockClient.js';
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
#
# Emitted as OpenAPI 3.0.3 with \`nullable: true\` rather than 3.1's
# \`anyOf: [X, {type: "null"}]\`: swift-openapi-generator does not support the
# 3.1 null type and drops nullable properties from the generated client
# entirely. See toOpenApi30 in src/server/openapi.ts.
`;

/**
 * A token is required to build the app, and generating a spec should not
 * require possession of the production credential. This placeholder never
 * authenticates anything: it exists only so route registration can proceed.
 */
const SPEC_ONLY_TOKEN = 'x'.repeat(64);

const REF_PREFIX = '#/components/schemas/';

/**
 * Rewrite the document from OpenAPI 3.1 to 3.0.3, converting nullability from
 * `anyOf: [X, {type: "null"}]` to `nullable: true`.
 *
 * This is not stylistic. `swift-openapi-generator` does not support the 3.1
 * null type: given the anyOf form it logs `Schema "null" is not supported` and
 * **drops the property entirely** — `quote`, `unrealized_pnl` and
 * `market_value` simply did not exist on the generated Swift structs, so the
 * app could not have read a degraded dashboard at all.
 *
 * The obvious 3.1-preserving fix, collapsing to `type: [X, "null"]`, is worse:
 * it fixes scalars but silently types a nullable `$ref` as non-optional, so
 * `DecisionResponse.execution` — null on every rejection — would have failed
 * to decode at runtime instead of failing loudly at build time.
 *
 * 3.0's `nullable` handles both. The cost is that a nullable `$ref` needs the
 * `allOf` wrapper below, which the generator surfaces as a nested payload with
 * a `.value1` hop at the call site. Three fields pay that price
 * (`execution`, `review`, `thesis_source`) and all three decode correctly,
 * which is the trade worth making.
 */
export function toOpenApi30(document: Record<string, unknown>): void {
  document.openapi = '3.0.3';

  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (node === null || typeof node !== 'object') return node;

    const record = node as Record<string, unknown>;
    const branches = record.anyOf;

    if (Array.isArray(branches)) {
      const isNull = (b: unknown): boolean =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'null';
      const nulls = branches.filter(isNull);
      const others = branches.filter((b) => !isNull(b));

      // Only the single-branch case is a nullability idiom. A genuine union of
      // two or more types plus null is a different thing and is left alone.
      if (nulls.length > 0 && others.length === 1) {
        const { anyOf: _dropped, ...siblings } = record;
        const branch = others[0] as Record<string, unknown>;

        if ('$ref' in branch) {
          // 3.0 ignores keys sitting beside a $ref, so the reference has to be
          // pushed inside an allOf for `nullable` to apply to it.
          return convert({ ...siblings, nullable: true, allOf: [branch] });
        }

        const merged: Record<string, unknown> = { ...branch, nullable: true };
        for (const [key, value] of Object.entries(siblings)) {
          if (!(key in merged)) merged[key] = value;
        }
        return convert(merged);
      }
    }

    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, convert(v)]));
  };

  for (const key of Object.keys(document)) {
    if (key !== 'openapi') document[key] = convert(document[key]);
  }
}

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
