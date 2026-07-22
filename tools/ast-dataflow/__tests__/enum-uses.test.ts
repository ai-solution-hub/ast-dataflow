import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, enumUses } from '@/tools/ast-dataflow';

/**
 * enum-uses query — Vitest suite
 *
 * Ground-truth fixture set under fixtures/13-enum-uses/.
 * Tests verify real behaviour per docs/reference/testing/test-philosophy.md:
 *   - Assertions are on the result shape and counts (not call-chain internals).
 *   - toHaveLength pins exact counts; no toBeGreaterThanOrEqual(1) + find() antipattern.
 *   - Test titles read like product specs (what the user observes), not implementation.
 *
 * KH currently has no native TS `enum` declarations; smoke scoped to fixture-only.
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '13-enum-uses');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixture case 1: declaration rows — the enum and its members are declared
// ──────────────────────────────────────────────────────────────────────────────

describe('enum-uses — fixture 1: enum declaration rows', () => {
  it('emits a declaration row for the enum itself', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    expect(response.query).toBe('enum-uses');
    expect(response.error).toBeUndefined();

    const declRows = response.results.filter((r) => r.kind === 'declaration');
    // The enum declaration in target-enum.ts must appear.
    expect(declRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'target-enum.ts',
          kind: 'declaration',
          memberName: null,
          confidence: 'exact',
        }),
      ]),
    );
  });

  it('emits declaration rows for each enum member', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    const memberDeclRows = response.results.filter(
      (r) => r.kind === 'declaration' && r.memberName !== null,
    );
    // OrderStatus has three members: PENDING, ACTIVE, CLOSED
    expect(memberDeclRows).toHaveLength(3);
    const memberNames = memberDeclRows.map((r) => r.memberName).sort();
    expect(memberNames).toEqual(['ACTIVE', 'CLOSED', 'PENDING']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Fixture case 2: memberAccess rows — E.MEMBER property access expressions
// ──────────────────────────────────────────────────────────────────────────────

describe('enum-uses — fixture 2: member access rows', () => {
  it('reports OrderStatus.PENDING in case-member-access.ts as memberAccess', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    expect(response.error).toBeUndefined();

    const memberAccessRows = response.results.filter(
      (r) => r.kind === 'memberAccess' && r.file === 'case-member-access.ts',
    );
    // case-member-access.ts has: OrderStatus.PENDING (×1), OrderStatus.ACTIVE (×1), OrderStatus.CLOSED (×1)
    expect(memberAccessRows).toHaveLength(3);

    const pendingRow = memberAccessRows.find((r) => r.memberName === 'PENDING');
    expect(pendingRow).toBeDefined();
    expect(pendingRow).toMatchObject({
      file: 'case-member-access.ts',
      kind: 'memberAccess',
      memberName: 'PENDING',
      confidence: 'exact',
    });
  });

  it('reports all member access sites across all fixture files', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    const memberAccessRows = response.results.filter(
      (r) => r.kind === 'memberAccess',
    );
    // case-member-access.ts: PENDING, ACTIVE, CLOSED (3)
    // target-enum.ts internal use: PENDING in defaultStatus (1)
    // case-aliased-import.ts: OS.ACTIVE, OS.PENDING (2)
    expect(memberAccessRows).toHaveLength(6);

    // All memberAccess rows must carry a non-null memberName
    for (const row of memberAccessRows) {
      expect(row.memberName).not.toBeNull();
    }
  });

  it('each memberAccess row carries an enclosing context', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    const memberAccessRows = response.results.filter(
      (r) => r.kind === 'memberAccess',
    );
    for (const row of memberAccessRows) {
      expect(typeof row.enclosing).toBe('string');
      expect(row.enclosing.length).toBeGreaterThan(0);
    }
  });

  it('reports aliased import member access rows (OS.ACTIVE and OS.PENDING) in case-aliased-import.ts', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    expect(response.error).toBeUndefined();

    const aliasedMemberAccessRows = response.results.filter(
      (r) => r.kind === 'memberAccess' && r.file === 'case-aliased-import.ts',
    );
    // case-aliased-import.ts: OS.ACTIVE (line 12) + OS.PENDING (line 15) = 2 memberAccess rows
    expect(aliasedMemberAccessRows).toHaveLength(2);
    expect(aliasedMemberAccessRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberName: 'ACTIVE',
          file: 'case-aliased-import.ts',
        }),
        expect.objectContaining({
          memberName: 'PENDING',
          file: 'case-aliased-import.ts',
        }),
      ]),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Fixture case 3: typePosition rows — x: E, fn(): E, Array<E>
// ──────────────────────────────────────────────────────────────────────────────

describe('enum-uses — fixture 3: type-position rows', () => {
  it('reports parameter type annotation as typePosition', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    expect(response.error).toBeUndefined();

    const typeRows = response.results.filter(
      (r) => r.kind === 'typePosition' && r.file === 'case-type-position.ts',
    );
    // case-type-position.ts has 5 type-position usages: parameter, return type, variable annotation, type assertion, generic arg
    expect(typeRows).toHaveLength(5);

    for (const row of typeRows) {
      expect(row).toMatchObject({
        kind: 'typePosition',
        confidence: 'exact',
      });
    }
  });

  it('reports return type annotation as typePosition', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    // case-type-position.ts: 5 type-position usages (parameter, return type, variable annotation, type assertion, generic arg)
    const typeRows = response.results.filter(
      (r) => r.kind === 'typePosition' && r.file === 'case-type-position.ts',
    );
    expect(typeRows).toHaveLength(5);
  });

  it('reports generic type argument (Array<OrderStatus>) as typePosition', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    // StatusList = Array<OrderStatus> is a type-position usage
    const typeRows = response.results.filter(
      (r) => r.kind === 'typePosition' && r.file === 'case-type-position.ts',
    );
    expect(typeRows).toHaveLength(5);
  });

  it('reports aliased import type annotation (OS) as typePosition', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    // case-aliased-import.ts: `status: OS` — should still be counted as typePosition
    const typeRows = response.results.filter(
      (r) => r.kind === 'typePosition' && r.file === 'case-aliased-import.ts',
    );
    expect(typeRows).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Fixture case 4: member filter — when member arg is supplied
// ──────────────────────────────────────────────────────────────────────────────

describe('enum-uses — fixture 4: member filter narrows results', () => {
  it('returns only PENDING member access rows when --member PENDING is supplied', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses(
      { enum: 'OrderStatus', member: 'PENDING' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();

    const memberAccessRows = response.results.filter(
      (r) => r.kind === 'memberAccess',
    );
    // When filtering to PENDING, all memberAccess rows must have memberName 'PENDING'
    for (const row of memberAccessRows) {
      expect(row.memberName).toBe('PENDING');
    }
    // target-enum.ts self-use (1) + case-member-access.ts (1) + case-aliased-import.ts OS.PENDING (1) = 3
    expect(memberAccessRows).toHaveLength(3);
  });

  it('excludes ACTIVE member access rows when filtering to PENDING', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses(
      { enum: 'OrderStatus', member: 'PENDING' },
      project,
      repoRoot,
    );

    const activeRows = response.results.filter(
      (r) => r.kind === 'memberAccess' && r.memberName === 'ACTIVE',
    );
    expect(activeRows).toHaveLength(0);
  });

  it('includes a declaration row for the enum itself regardless of member filter', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses(
      { enum: 'OrderStatus', member: 'PENDING' },
      project,
      repoRoot,
    );

    // The enum-level declaration row is always emitted
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'declaration',
          memberName: null,
          file: 'target-enum.ts',
        }),
      ]),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Result shape invariants
// ──────────────────────────────────────────────────────────────────────────────

describe('enum-uses — result shape invariants', () => {
  it('all rows carry file, line, column, kind, memberName, enclosing, confidence', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    expect(response.error).toBeUndefined();
    expect(response.results.length).toBeGreaterThan(0);

    for (const row of response.results) {
      expect(typeof row.file).toBe('string');
      expect(row.file.length).toBeGreaterThan(0);
      expect(typeof row.line).toBe('number');
      expect(row.line).toBeGreaterThanOrEqual(1);
      expect(typeof row.column).toBe('number');
      expect(row.column).toBeGreaterThanOrEqual(1);
      expect(['declaration', 'memberAccess', 'typePosition']).toContain(
        row.kind,
      );
      // memberName: null for enum-level rows, string for member rows
      expect(
        row.memberName === null || typeof row.memberName === 'string',
      ).toBe(true);
      expect(typeof row.enclosing).toBe('string');
      expect(row.confidence).toBe('exact');
    }
  });

  it('all result paths are repo-root-relative (no absolute paths)', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    for (const row of response.results) {
      expect(row.file.startsWith('/')).toBe(false);
      expect(row.file.startsWith('\\')).toBe(false);
    }
  });

  it('returns structured error for unknown enum name', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses(
      { enum: 'NonExistentEnum' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('out_of_corpus');
    expect(response.results).toHaveLength(0);
  });

  it('returns structured error for empty enum name', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: '' }, project, repoRoot);

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toHaveLength(0);
  });

  it('response carries query name, args, truncated, durationMs', async () => {
    const { project, repoRoot } = makeProject();

    const response = await enumUses({ enum: 'OrderStatus' }, project, repoRoot);

    expect(response.query).toBe('enum-uses');
    expect(response.args).toMatchObject({ enum: 'OrderStatus' });
    expect(typeof response.truncated).toBe('boolean');
    expect(typeof response.durationMs).toBe('number');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });
});
