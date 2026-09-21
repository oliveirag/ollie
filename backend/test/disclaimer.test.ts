import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER_TEXT,
  DISCLAIMER_VERSION,
  currentDisclaimer,
} from '../src/published/disclaimer.js';
import { DISCLAIMER_PATH } from '../src/server/paths.js';

describe('the disclaimer', () => {
  it('is versioned by the hash of its exact text', () => {
    expect(DISCLAIMER_VERSION).toBe(createHash('sha256').update(DISCLAIMER_TEXT).digest('hex'));
    expect(currentDisclaimer()).toEqual({ version: DISCLAIMER_VERSION, text: DISCLAIMER_TEXT });
  });

  it('matches the checked-in docs/disclaimer.md', async () => {
    // The same arrangement as openapi.yaml: the constant is the source, the
    // markdown is generated, and this fails until `npm run disclaimer:write`.
    const checkedIn = await readFile(DISCLAIMER_PATH, 'utf8');
    expect(
      checkedIn,
      'docs/disclaimer.md is out of date with DISCLAIMER_TEXT. Run `npm run disclaimer:write`.',
    ).toBe(DISCLAIMER_TEXT);
  });

  it.each([
    'not financial advice',
    'Past performance is not indicative of future results',
    'own risk',
    'own account',
    'not personalized',
  ])('states the required element: %s', (phrase) => {
    // PRD §9's required elements, pinned so a rewrite cannot drop one.
    expect(DISCLAIMER_TEXT.toLowerCase()).toContain(phrase.toLowerCase());
  });
});
