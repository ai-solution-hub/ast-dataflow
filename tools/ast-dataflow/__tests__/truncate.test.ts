import { describe, expect, it } from 'vitest';
import { truncateSpatial } from '@/tools/ast-dataflow/truncate';
import type { BaseResult } from '@/tools/ast-dataflow/types';

/**
 * truncateSpatial — pure unit suite (no ts-morph).
 *
 * PRODUCT inv 14: truncation prefers spatial coverage — distinct files come
 * first, multiple hits per file thin last. Output is deterministically sorted
 * by (file, line, column) regardless of input (discovery) order.
 */

function row(file: string, line: number, column: number): BaseResult {
  return { file, line, column, confidence: 'exact' };
}

describe('truncateSpatial — under the limit', () => {
  it('returns every row sorted by (file, line, column) with truncated false and no totalEstimated', () => {
    const input = [row('b.ts', 5, 1), row('a.ts', 9, 1), row('a.ts', 2, 4)];

    const t = truncateSpatial(input, 10);

    expect(t.rows).toHaveLength(3);
    expect(t.rows).toEqual([
      row('a.ts', 2, 4),
      row('a.ts', 9, 1),
      row('b.ts', 5, 1),
    ]);
    expect(t.truncated).toBe(false);
    expect(t.totalEstimated).toBeUndefined();
  });
});

describe('truncateSpatial — over the limit', () => {
  it('represents every file when the distinct-file count fits within the limit', () => {
    // 3 files × 3 hits = 9 rows, limit 5 → all 3 files must appear.
    const input = ['a.ts', 'b.ts', 'c.ts'].flatMap((f) => [
      row(f, 1, 1),
      row(f, 2, 1),
      row(f, 3, 1),
    ]);

    const t = truncateSpatial(input, 5);

    expect(t.rows).toHaveLength(5);
    const files = new Set(t.rows.map((r) => r.file));
    expect([...files].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(t.truncated).toBe(true);
    expect(t.totalEstimated).toBe(9);
  });

  it('keeps a heavy file represented by its earliest hits while every light file still appears (skew case)', () => {
    // fileA × 150 + 50 files × 2 = 250 rows, limit 100 → all 51 files present.
    const heavy = Array.from({ length: 150 }, (_, i) => row('a.ts', i + 1, 1));
    const lightFiles = Array.from(
      { length: 50 },
      (_, i) => `f${String(i + 1).padStart(2, '0')}.ts`,
    );
    const light = lightFiles.flatMap((f) => [row(f, 1, 1), row(f, 2, 1)]);

    const t = truncateSpatial([...heavy, ...light], 100);

    expect(t.rows).toHaveLength(100);
    const files = new Set(t.rows.map((r) => r.file));
    expect(files.size).toBe(51);
    // The heavy file keeps its EARLIEST lines — later hits thin first.
    const heavyLines = t.rows
      .filter((r) => r.file === 'a.ts')
      .map((r) => r.line);
    expect(heavyLines).toEqual([1, 2]);
    expect(t.truncated).toBe(true);
    expect(t.totalEstimated).toBe(250);
  });

  it('gives the first limit files lexicographically one row each when distinct files exceed the limit', () => {
    // 5 files × 2 hits, limit 3 → a.ts, b.ts, c.ts get one row each.
    const input = ['e.ts', 'd.ts', 'c.ts', 'b.ts', 'a.ts'].flatMap((f) => [
      row(f, 1, 1),
      row(f, 2, 1),
    ]);

    const t = truncateSpatial(input, 3);

    expect(t.rows).toHaveLength(3);
    expect(t.rows).toEqual([
      row('a.ts', 1, 1),
      row('b.ts', 1, 1),
      row('c.ts', 1, 1),
    ]);
    expect(t.truncated).toBe(true);
    expect(t.totalEstimated).toBe(10);
  });

  it('produces identical output for shuffled input (deterministic, discovery-order independent)', () => {
    const input = [
      row('b.ts', 1, 1),
      row('a.ts', 3, 1),
      row('c.ts', 2, 1),
      row('a.ts', 1, 1),
      row('b.ts', 4, 1),
      row('c.ts', 5, 1),
    ];
    const shuffled = [
      input[4],
      input[0],
      input[5],
      input[2],
      input[1],
      input[3],
    ];

    const fromOriginal = truncateSpatial(input, 4);
    const fromShuffled = truncateSpatial(shuffled, 4);

    expect(fromShuffled.rows).toEqual(fromOriginal.rows);
    expect(fromShuffled.totalEstimated).toBe(fromOriginal.totalEstimated);
  });

  it('reports totalEstimated as the exact full hit count, not the kept-row count', () => {
    const input = Array.from({ length: 7 }, (_, i) => row('a.ts', i + 1, 1));

    const t = truncateSpatial(input, 2);

    expect(t.rows).toHaveLength(2);
    expect(t.totalEstimated).toBe(7);
  });

  it('breaks same-file same-line ties by column', () => {
    const input = [row('a.ts', 1, 9), row('a.ts', 1, 3), row('a.ts', 1, 6)];

    const t = truncateSpatial(input, 2);

    expect(t.rows).toEqual([row('a.ts', 1, 3), row('a.ts', 1, 6)]);
    expect(t.truncated).toBe(true);
    expect(t.totalEstimated).toBe(3);
  });
});
