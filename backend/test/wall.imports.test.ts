import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The import-graph half of the §4.5 proof (Phase 4, decision 5).
 *
 * Walks every runtime import reachable from `src/signal-server/` and fails if
 * the walk reaches the broker adapter, the executor, the push dispatcher, the
 * Anthropic client, or the orchestrator's scheduler and pipeline. The service
 * cannot place an order because it cannot construct the object whose only
 * write method throws — that is a property of the module graph, and this test
 * is what keeps it one.
 *
 * `import type` lines are skipped: they are erased at compile time and can
 * reach no code. Everything else — static imports, re-exports, dynamic
 * `import()` of a literal path — counts.
 */

const SRC = resolve(__dirname, '../src');
const ROOT = join(SRC, 'signal-server');

const FORBIDDEN_PATHS = [
  'orchestrator/robinhood/',
  'orchestrator/executor',
  'orchestrator/push/',
  'orchestrator/anthropic/',
  'orchestrator/pipeline',
  'orchestrator/scheduler',
  'orchestrator/marks',
  'orchestrator/publish',
  'server/app',
  'server/routes/',
];

const FORBIDDEN_PACKAGES = ['@anthropic-ai/sdk'];

const IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\s)[^'"]*?\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listTsFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(from: string, specifier: string): string {
  const resolved = resolve(dirname(from), specifier);
  return resolved.replace(/\.js$/, '.ts');
}

/** Every module reachable from the roots, plus the bare packages they pull in. */
function walk(roots: string[]): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier));
      } else {
        packages.add(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
      }
    }
  }
  return { modules, packages };
}

describe('the signal service import graph', () => {
  const { modules, packages } = walk(listTsFiles(ROOT));
  const reached = [...modules].map((m) => relative(SRC, m)).sort();

  it('walks a non-trivial graph', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true, so pin that the walk actually got somewhere.
    expect(reached).toContain('signal-server/index.ts');
    expect(reached).toContain('db/signals.ts');
    expect(reached).toContain('published/signal.ts');
    expect(reached.length).toBeGreaterThan(15);
  });

  it.each(FORBIDDEN_PATHS)('never reaches %s', (forbidden) => {
    const hits = reached.filter((path) => path.startsWith(forbidden));
    expect(hits, `reachable from signal-server: ${hits.join(', ')}`).toEqual([]);
  });

  it.each(FORBIDDEN_PACKAGES)('never imports %s', (pkg) => {
    expect([...packages]).not.toContain(pkg);
  });

  it('reads the review snapshot parser only through type imports of the broker', () => {
    // reviewSnapshot.ts sits beside the broker code and is legitimately
    // reachable (it parses a stored JSON shape). Its own broker import must be
    // type-only, or the exemption above would be a hole.
    const source = readFileSync(join(SRC, 'orchestrator/reviewSnapshot.ts'), 'utf8');
    const brokerImports = source.match(/^\s*import\s.*robinhood.*$/gm) ?? [];
    for (const line of brokerImports) expect(line).toMatch(/^\s*import type /);
  });
});
