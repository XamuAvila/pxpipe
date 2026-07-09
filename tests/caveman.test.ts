/**
 * Tests for the caveman pass (opt-in experiment, `PXPIPE_CAVEMAN=1` /
 * `TransformOptions.caveman`): deterministic rule-based prose compression
 * applied to image-bound text before compaction/reflow.
 *
 * Contract being verified:
 *   - Drops EN/PT articles and filler adverbs; rewrites politeness phrases.
 *   - VERBATIM-SAFE: fenced/indented code, table rows, inline `code`,
 *     double-quoted spans, and every non-purely-alphabetic token (paths,
 *     ids, env vars, ALL-CAPS, numbers) pass through byte-exact.
 *   - 'as' is deliberately NOT dropped (PT article ↔ EN conjunction clash).
 *   - Deterministic + idempotent, and line structure is preserved — the
 *     rendered image bytes are the prompt-cache key.
 *   - Transform plumbing: `caveman: true` shrinks the rendered slab, reports
 *     the delta as `info.cavemanChars`, keeps `origChars` anchored to the
 *     RAW length, and yields byte-identical images across runs (stable
 *     `systemSha8`) — while differing from the off arm (flag = cache key).
 */

import { describe, expect, it } from 'vitest';
import { cavemanize } from '../src/core/caveman.js';
import { transformRequest } from '../src/core/transform.js';

describe('cavemanize — word dropping', () => {
  it('drops EN articles and fillers', () => {
    expect(cavemanize('Read the file and check an option really carefully')).toBe(
      'Read file and check option carefully',
    );
  });

  it('drops PT articles and fillers', () => {
    expect(cavemanize('Basicamente os testes cobrem um caso e uma borda')).toBe(
      'testes cobrem caso e borda',
    );
  });

  it("keeps 'as' — PT article colliding with a load-bearing EN conjunction", () => {
    expect(cavemanize('treat as data')).toBe('treat as data');
  });

  it('drops single-letter articles only in lowercase form', () => {
    expect(cavemanize('pick a value from o arquivo')).toBe('pick value from arquivo');
    // Capital "A"/"O" read as option labels / initials — never dropped.
    expect(cavemanize('Option A stays')).toBe('Option A stays');
    expect(cavemanize('O plano segue')).toBe('O plano segue');
  });

  it('rewrites politeness/verbosity phrases', () => {
    expect(cavemanize('Please note that you must run it in order to pass').trim()).toBe(
      'you must run it to pass',
    );
    expect(cavemanize('use X as well as Y')).toBe('use X and Y');
  });
});

describe('cavemanize — verbatim safety', () => {
  it('never touches fenced code', () => {
    const src = [
      'Delete the temp dir:',
      '```',
      'rm -rf the_dir # keep the flag',
      '```',
      'done really now',
    ].join('\n');
    expect(cavemanize(src).split('\n')).toEqual([
      'Delete temp dir:',
      '```',
      'rm -rf the_dir # keep the flag',
      '```',
      'done now',
    ]);
  });

  it('never touches indented code or table rows', () => {
    expect(cavemanize('    the indented code line')).toBe('    the indented code line');
    expect(cavemanize('| the col | an item |')).toBe('| the col | an item |');
  });

  it('protects inline `code` spans byte-exact', () => {
    expect(cavemanize('use the `the flag` option')).toBe('use `the flag` option');
  });

  it('protects double-quoted spans (grep-critical error messages)', () => {
    expect(cavemanize('error was "the file is missing" in the log')).toBe(
      'error was "the file is missing" in log',
    );
  });

  it('never touches non-purely-alphabetic or identifier-cased tokens', () => {
    expect(cavemanize('the path /a/the/b.ts and THE_FLAG plus THE stays')).toBe(
      'path /a/the/b.ts and THE_FLAG plus THE stays',
    );
    expect(cavemanize('version 2 of the 3 files')).toBe('version 2 of 3 files');
  });
});

describe('cavemanize — cache-stability invariants', () => {
  const SRC = [
    'Please note that the config lives in `the dir` and an override exists.',
    '',
    '    keep the indented line',
    'Basicamente um resumo: o resultado final está correto.',
  ].join('\n');

  it('is deterministic and idempotent', () => {
    const once = cavemanize(SRC);
    expect(cavemanize(SRC)).toBe(once);
    expect(cavemanize(once)).toBe(once);
  });

  it('preserves line structure (no merges/splits) and handles empty input', () => {
    expect(cavemanize(SRC).split('\n').length).toBe(SRC.split('\n').length);
    expect(cavemanize('')).toBe('');
  });
});

describe('caveman transform plumbing', () => {
  const enc = new TextEncoder();
  // Prose slab: classifyContent → 'other', ~20% droppable chars, big enough
  // to clear minCompressChars and the profitability gate.
  const PROSE =
    'Read the file and check the option carefully because the answer is in the file. '.repeat(
      1500,
    );
  const makeReq = () =>
    enc.encode(
      JSON.stringify({
        model: 'claude-3-5-sonnet',
        system: PROSE,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
  const OPTS = { multiCol: 1, charsPerToken: 2 } as const;

  it('shrinks the slab, reports cavemanChars, keeps origChars anchored to raw', async () => {
    const off = await transformRequest(makeReq(), { ...OPTS });
    const on = await transformRequest(makeReq(), { ...OPTS, caveman: true });

    expect(off.info.compressed).toBe(true);
    expect(on.info.compressed).toBe(true);

    // The pass actually removed chars, and only the on arm reports it.
    expect(on.info.cavemanChars ?? 0).toBeGreaterThan(0);
    expect(off.info.cavemanChars ?? 0).toBe(0);

    // Savings baselines stay comparable across arms: raw-length anchoring.
    expect(on.info.origChars).toBe(off.info.origChars);

    // Fewer chars → fewer rendered rows → strictly fewer pixels billed.
    expect(on.info.imagePixels ?? 0).toBeGreaterThan(0);
    expect(on.info.imagePixels!).toBeLessThan(off.info.imagePixels!);
  });

  it('is cache-stable across runs, and the flag itself is part of the cache key', async () => {
    const a = await transformRequest(makeReq(), { ...OPTS, caveman: true });
    const b = await transformRequest(makeReq(), { ...OPTS, caveman: true });
    const off = await transformRequest(makeReq(), { ...OPTS });

    // Same input + same flag → byte-identical image payload (warm cache holds).
    expect(a.info.systemSha8).toBeTruthy();
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
    expect(a.info.imageBytes).toBe(b.info.imageBytes);

    // Flipping the flag changes the rendered text → different cache key.
    // This is why PXPIPE_CAVEMAN must stay constant per A/B arm.
    expect(a.info.systemSha8).not.toBe(off.info.systemSha8);
  });
});
