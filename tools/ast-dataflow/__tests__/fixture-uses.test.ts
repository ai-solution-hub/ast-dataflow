import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureUses, createProject } from '@/tools/ast-dataflow';
import type { FixtureUseKind, FixtureUsesArgs } from '@/tools/ast-dataflow';

/**
 * fixture-uses query — Vitest suite
 *
 * Ground-truth fixture corpus under fixtures/20-fixture-uses/, replicating the
 * real repo layout (repoRoot = the fixture dir): __tests__/fixtures JSON + TS,
 * an adversarial __tests__/unit/*.test.ts that must NOT be scanned, e2e and
 * scripts/tests fixture roots, docs/ontology frontmatter, and a miniature
 * supabase/types/database.types.ts.
 *
 * Row shape:
 *   { file, line, column, confidence: 'indirect', kind, fileType, context }
 *   kind: 'key' | 'value'; fileType: 'json' | 'ts' | 'md-frontmatter'
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '20-fixture-uses');

async function run(args: FixtureUsesArgs) {
  const { project, repoRoot } = createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
  return fixtureUses(args, project, repoRoot);
}

// ---------------------------------------------------------------------------
// JSON mode: key vs value separation + exact-match discipline (rows.json)
// ---------------------------------------------------------------------------
describe('fixture-uses — JSON key vs value separation in rows.json', () => {
  it("returns three key rows and one value row for 'project_id' in rows.json", async () => {
    const response = await run({ needle: 'project_id' });

    expect(response.query).toBe('fixture-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === '__tests__/fixtures/rows.json',
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.kind === 'key')).toHaveLength(3);
    const values = rows.filter((r) => r.kind === 'value');
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      kind: 'value',
      fileType: 'json',
      context: 'note',
    });
  });

  it("excludes the 'project_id_old' decoy value from the rows.json matches", async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === '__tests__/fixtures/rows.json',
    );
    // The decoy sits alone on line 4 — no row may point there.
    expect(rows.filter((r) => r.line === 4)).toHaveLength(0);
  });

  it('matches the escape-spelled "project\\u005fid" key after decoding', async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === '__tests__/fixtures/rows.json',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'key',
          line: 9,
          context: 'escaped.project_id',
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Position fidelity (inv 13: 1-based line/column)
// ---------------------------------------------------------------------------
describe('fixture-uses — position fidelity for JSON rows', () => {
  it('reports 1-based line/column for a known key and a known value', async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === '__tests__/fixtures/rows.json',
    );
    // Top-level key on line 2: `  "project_id": "abc-123",` — quote at col 3.
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'key', line: 2, column: 3 }),
      ]),
    );
    // Value on line 3: `  "note": "project_id",` — quote at col 11.
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'value', line: 3, column: 11 }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Structural context paths (JSON stack + YAML ancestry)
// ---------------------------------------------------------------------------
describe('fixture-uses — structural context paths', () => {
  it("reports 'rows[1].project_id' for the key nested in the JSON rows array", async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === '__tests__/fixtures/rows.json',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'key', context: 'rows[1].project_id' }),
      ]),
    );
  });

  it("reports 'baseline_values[0].key' for the YAML sequence-item value", async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === 'docs/ontology/01-taxonomy.md',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'value',
          context: 'baseline_values[0].key',
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// kinds filter + invalid kind
// ---------------------------------------------------------------------------
describe('fixture-uses — kinds filter', () => {
  it("returns only the ten key rows when kinds is ['key']", async () => {
    const response = await run({ needle: 'project_id', kinds: ['key'] });

    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(10);
    expect(response.results.every((r) => r.kind === 'key')).toBe(true);
  });

  it('returns a parse_error structured response for an invalid kind string', async () => {
    const response = await run({
      needle: 'project_id',
      kinds: ['bogus' as FixtureUseKind],
    });

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Convention gate (D1: /fixtures/ segment OR *-fixture.ts basename)
// ---------------------------------------------------------------------------
describe('fixture-uses — fixture-by-convention gate', () => {
  it('never scans __tests__/unit/not-a-fixture.test.ts despite the needle inside', async () => {
    const response = await run({ needle: 'project_id' });

    const files = new Set(response.results.map((r) => r.file));
    expect(files.has('__tests__/unit/not-a-fixture.test.ts')).toBe(false);
  });

  it('scans both /fixtures/-segment files and *-fixture.ts basename files', async () => {
    const response = await run({ needle: 'project_id' });

    const files = new Set(response.results.map((r) => r.file));
    expect(files.has('__tests__/fixtures/typed-rows.ts')).toBe(true);
    expect(files.has('__tests__/unit/helper-fixture.ts')).toBe(true);
    expect(files.has('e2e/fixtures/seed-fixture.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// database.types.ts (D3: PropertySignature → key, union literal → value)
// ---------------------------------------------------------------------------
describe('fixture-uses — database.types.ts kind mapping', () => {
  it('maps the Row/Insert PropertySignatures to two ts key rows', async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === 'supabase/types/database.types.ts',
    );
    expect(rows).toHaveLength(3);
    const keys = rows.filter((r) => r.kind === 'key');
    expect(keys).toHaveLength(2);
    for (const row of keys) {
      expect(row).toMatchObject({ kind: 'key', fileType: 'ts' });
    }
  });

  it('maps the string-literal union member to a ts value row', async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === 'supabase/types/database.types.ts',
    );
    expect(rows.filter((r) => r.kind === 'value')).toHaveLength(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'value', fileType: 'ts' }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown frontmatter (body never scanned)
// ---------------------------------------------------------------------------
describe('fixture-uses — markdown frontmatter mode', () => {
  it('returns one key row and one value row from the taxonomy frontmatter', async () => {
    const response = await run({ needle: 'project_id' });

    const rows = response.results.filter(
      (r) => r.file === 'docs/ontology/01-taxonomy.md',
    );
    // Exactly 2 — the body occurrence of the needle would make a third.
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'key',
          fileType: 'md-frontmatter',
          context: 'project_id',
        }),
        expect.objectContaining({
          kind: 'value',
          fileType: 'md-frontmatter',
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Target-root coverage + non-text extension routing
// ---------------------------------------------------------------------------
describe('fixture-uses — target roots and extension routing', () => {
  it('collects rows from the e2e and scripts/tests fixture roots', async () => {
    const response = await run({ needle: 'project_id' });

    const files = new Set(response.results.map((r) => r.file));
    expect(files.has('e2e/fixtures/payload.json')).toBe(true);
    expect(files.has('e2e/fixtures/seed-fixture.ts')).toBe(true);
    expect(files.has('scripts/tests/fixtures/snapshot.json')).toBe(true);
  });

  it('skips blob.bin without a row or an error even when --scope pulls it in', async () => {
    const response = await run({
      needle: 'project_id',
      scope: 'e2e/fixtures/**',
    });

    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(2);
    const files = response.results.map((r) => r.file).sort();
    expect(files).toEqual([
      'e2e/fixtures/payload.json',
      'e2e/fixtures/seed-fixture.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Row invariants (inv 15 indirect confidence, inv 16 in-corpus POSIX paths)
// ---------------------------------------------------------------------------
describe('fixture-uses — row shape invariants', () => {
  it("returns all sixteen corpus rows with confidence 'indirect' and relative POSIX paths", async () => {
    const response = await run({ needle: 'project_id' });

    expect(response.results).toHaveLength(16);
    for (const row of response.results) {
      expect(row.confidence).toBe('indirect');
      expect(row.file.startsWith('/')).toBe(false);
      expect(row.file).not.toContain('\\');
      expect(row.file).not.toContain('..');
    }
  });

  it('response envelope has query name, args, truncated flag, and durationMs', async () => {
    const response = await run({ needle: 'project_id' });

    expect(response.query).toBe('fixture-uses');
    expect(response.args).toMatchObject({ needle: 'project_id', limit: 200 });
    expect(response.truncated).toBe(false);
    expect(typeof response.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Spatial-coverage truncation (inv 14: distinct files first)
// ---------------------------------------------------------------------------
describe('fixture-uses — spatial-coverage truncation with a low limit', () => {
  it('keeps two distinct files represented and reports the exact un-truncated total', async () => {
    const response = await run({ needle: 'project_id', limit: 2 });

    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(2);
    const files = new Set(response.results.map((r) => r.file));
    expect(files.size).toBe(2);
    expect(response.truncated).toBe(true);
    expect(response.totalEstimated).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Error contract: empty needle (inv 29)
// ---------------------------------------------------------------------------
describe('fixture-uses — error contract: missing needle argument', () => {
  it('returns a parse_error structured response when needle is empty string', async () => {
    const response = await run({ needle: '' });

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON tolerance
// ---------------------------------------------------------------------------
describe('fixture-uses — malformed JSON fixture tolerance', () => {
  it('still returns the rows lexed from malformed.json without crashing', async () => {
    const response = await run({ needle: 'legacy_col' });

    expect(response.error).toBeUndefined();
    const rows = response.results.filter(
      (r) => r.file === '__tests__/fixtures/malformed.json',
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'key', context: 'legacy_col' }),
        expect.objectContaining({ kind: 'value', context: 'note' }),
      ]),
    );
  });
});
