import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { renderOpenApiYaml } from '../src/server/openapi.js';
import { OPENAPI_PATH } from '../src/server/paths.js';
import { pruneUnreferencedSchemas, toOpenApi30 } from '../src/server/openapi.js';

/**
 * The contract test. `docs/openapi.yaml` is what the Swift client is generated
 * from, so a route change that does not reach the file produces a client that
 * compiles against an API that no longer exists. Failing here is the cheap
 * version of that discovery.
 */
describe('openapi contract', () => {
  it('matches the checked-in docs/openapi.yaml', async () => {
    const [rendered, checkedIn] = await Promise.all([
      renderOpenApiYaml(),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    expect(
      rendered,
      'docs/openapi.yaml is out of date with the route schemas. Run `npm run openapi:write`.',
    ).toBe(checkedIn);
  });

  it('describes every route the app serves', async () => {
    const rendered = await renderOpenApiYaml();

    // Spot-check rather than re-derive: the point is that the document is not
    // silently empty, which a broken transform would otherwise produce while
    // still matching a stale file that was written from the same breakage.
    expect(rendered).toContain('/healthz');
    expect(rendered).toContain('/v1/signals');
    expect(rendered).toContain('ownerToken');
  });
});

describe('nullability the Swift generator can actually read', () => {
  it('emits 3.0.3 with nullable instead of a 3.1 null union', async () => {
    const rendered = await renderOpenApiYaml();
    const document = parse(rendered) as Record<string, unknown>;

    expect(document.openapi).toBe('3.0.3');

    // Walk the parsed document rather than grepping the text — the header
    // comment mentions the 3.1 form it exists to explain, and a substring
    // check would match that instead of a real schema.
    const nullTypes: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type' && value === 'null') nullTypes.push(path);
        walk(value, `${path}.${key}`);
      }
    };
    walk(document, '$');

    // Any survivor is a property swift-openapi-generator would drop silently.
    expect(nullTypes).toEqual([]);
  });

  it('keeps every nullable response field nullable', async () => {
    const document = parse(await renderOpenApiYaml()) as {
      components: { schemas: Record<string, { properties: Record<string, { nullable?: boolean }> }> };
    };

    // These are the fields whose null case the app must actually handle: a
    // broker outage, a rejection with no fill, an unreadable review snapshot.
    const lot = document.components.schemas.OpenLot!.properties;
    expect(lot.quote!.nullable).toBe(true);
    expect(lot.unrealized_pnl!.nullable).toBe(true);
    expect(lot.quote_age_seconds!.nullable).toBe(true);

    const decision = document.components.schemas.DecisionResponse!.properties;
    expect(decision.execution!.nullable).toBe(true);

    const summary = document.components.schemas.SignalSummary!.properties;
    expect(summary.estimated_price!.nullable).toBe(true);
    expect(summary.thesis_source!.nullable).toBe(true);
  });

  it('wraps a nullable $ref in allOf so 3.0 does not ignore the sibling', () => {
    // Bare `{$ref, nullable: true}` is silently non-nullable in 3.0, which is
    // how execution came back non-optional and failed to decode a rejection.
    const document: Record<string, unknown> = {
      openapi: '3.1.0',
      components: {
        schemas: {
          Wrapper: {
            type: 'object',
            properties: {
              thing: { anyOf: [{ $ref: '#/components/schemas/Thing' }, { type: 'null' }] },
            },
          },
        },
      },
    };

    toOpenApi30(document);

    const thing = (document.components as any).schemas.Wrapper.properties.thing;
    expect(thing.nullable).toBe(true);
    expect(thing.allOf).toEqual([{ $ref: '#/components/schemas/Thing' }]);
    expect(thing.$ref).toBeUndefined();
  });

  it('leaves a genuine multi-type union alone', () => {
    // Only the single-branch-plus-null shape is a nullability idiom. Collapsing
    // a real union would silently discard one of its arms.
    const document: Record<string, unknown> = {
      openapi: '3.1.0',
      components: {
        schemas: {
          U: {
            properties: {
              either: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
            },
          },
        },
      },
    };

    toOpenApi30(document);

    const either = (document.components as any).schemas.U.properties.either;
    expect(either.anyOf).toHaveLength(3);
    expect(either.nullable).toBeUndefined();
  });
});

describe('pruneUnreferencedSchemas', () => {
  it('keeps schemas reached transitively through another schema', () => {
    const document = {
      paths: { '/a': { get: { responses: { 200: { $ref: '#/components/schemas/Kept' } } } } },
      components: {
        schemas: {
          Kept: { properties: { nested: { $ref: '#/components/schemas/Nested' } } },
          Nested: { type: 'string' },
          Orphan: { type: 'string' },
        },
      },
    };

    pruneUnreferencedSchemas(document);

    const schemas = document.components.schemas;
    expect(Object.keys(schemas).sort()).toEqual(['Kept', 'Nested']);
  });

  it('does not treat a schema referencing itself as reachable', () => {
    // Two orphans that only reference each other must both go; a naive
    // implementation that seeds the reachable set from every $ref in the whole
    // document (components included) would keep them forever.
    const document = {
      paths: {},
      components: {
        schemas: {
          OrphanA: { properties: { b: { $ref: '#/components/schemas/OrphanB' } } },
          OrphanB: { properties: { a: { $ref: '#/components/schemas/OrphanA' } } },
        },
      },
    };

    pruneUnreferencedSchemas(document);

    expect(Object.keys(document.components.schemas)).toEqual([]);
  });
});
