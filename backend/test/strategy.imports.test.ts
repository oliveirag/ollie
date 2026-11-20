import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Non-negotiable 1, as a property of the module graph: the strategy engine is
 * pure functions over OHLCV. Every runtime import reachable from
 * `src/orchestrator/strategy/` must stay inside it, apart from `money.ts`
 * (decimal arithmetic). A database, broker, clock source, LLM client or config
 * read added to the strategy fails here. `import type` is erased at compile
 * time and is allowed.
 */

const SRC = resolve(__dirname, '../src');
const ROOT = join(SRC, 'orchestrator/strategy');
const ALLOWED_OUTSIDE = new Set(['money.ts']);
const ALLOWED_PACKAGES = new Set(['@prisma/client']); // money.ts: Prisma.Decimal only

const IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\s)[^'"]*?\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function walk(roots: string[]): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier).replace(/\.js$/, '.ts'));
      } else {
        packages.add(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
      }
    }
  }
  return { modules, packages };
}

describe('the strategy import graph', () => {
  const roots = readdirSync(ROOT)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ROOT, f));
  const { modules, packages } = walk(roots);
  const reached = [...modules].map((m) => relative(SRC, m)).sort();

  it('walks the strategy files', () => {
    expect(reached).toContain('orchestrator/strategy/technical.ts');
    expect(reached).toContain('orchestrator/strategy/indicators.ts');
  });

  it('reaches nothing outside the strategy but money.ts', () => {
    const outside = reached.filter(
      (path) => !path.startsWith('orchestrator/strategy/') && !ALLOWED_OUTSIDE.has(path),
    );
    expect(outside).toEqual([]);
  });

  it('imports no package beyond the decimal type', () => {
    expect([...packages].filter((p) => !ALLOWED_PACKAGES.has(p))).toEqual([]);
  });
});
