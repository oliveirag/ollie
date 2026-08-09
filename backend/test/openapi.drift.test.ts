import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderOpenApiYaml } from '../src/server/openapi.js';
import { OPENAPI_PATH } from '../src/server/paths.js';
import { pruneUnreferencedSchemas } from '../src/server/openapi.js';

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
