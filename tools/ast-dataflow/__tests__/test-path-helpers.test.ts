/**
 * Canonical isTestFilePath tests.
 *
 * isTestFilePath lives in resolve.ts (single source of truth).
 * column-reads.ts and column-writes.ts import from there — they must NOT
 * define their own local copies.
 */
import { describe, expect, it } from 'vitest';
import { isTestFilePath } from '@/tools/ast-dataflow/resolve';

describe('isTestFilePath — canonical behaviour', () => {
  // ── Standard test-suffix patterns (portable across all frameworks) ──────

  it('detects .test.ts suffix', () => {
    expect(isTestFilePath('lib/utils/format.test.ts')).toBe(true);
  });

  it('detects .test.tsx suffix', () => {
    expect(isTestFilePath('components/Button.test.tsx')).toBe(true);
  });

  it('detects .spec.ts suffix', () => {
    expect(isTestFilePath('lib/utils/format.spec.ts')).toBe(true);
  });

  it('detects .spec.tsx suffix', () => {
    expect(isTestFilePath('components/Button.spec.tsx')).toBe(true);
  });

  // ── KH-style __tests__/ root prefix ──────────────────────────────────────

  it('detects __tests__/ root prefix (KH convention)', () => {
    expect(
      isTestFilePath('tools/ast-dataflow/__tests__/importers.test.ts'),
    ).toBe(true);
  });

  it('detects __tests__/ root prefix (flat fixture)', () => {
    expect(isTestFilePath('__tests__/helpers/mock-supabase.ts')).toBe(true);
  });

  // ── Vite-style src/__tests__/ prefix ─────────────────────────────────────

  it('detects src/__tests__/ prefix (Vite create-vite scaffold convention)', () => {
    expect(isTestFilePath('src/__tests__/utils/format.ts')).toBe(true);
  });

  it('detects src/__tests__/ prefix for nested files', () => {
    expect(isTestFilePath('src/__tests__/components/Button.ts')).toBe(true);
  });

  // ── Generic /test/ directory segment ─────────────────────────────────────

  it('detects /test/ directory segment', () => {
    expect(isTestFilePath('lib/test/helpers.ts')).toBe(true);
  });

  it('detects nested /test/ segment', () => {
    expect(isTestFilePath('packages/core/test/index.ts')).toBe(true);
  });

  // ── Production file paths — must NOT be flagged as tests ─────────────────

  it('does NOT flag production lib file', () => {
    expect(isTestFilePath('tools/ast-dataflow/resolve.ts')).toBe(false);
  });

  it('does NOT flag production component file', () => {
    expect(isTestFilePath('components/Button.tsx')).toBe(false);
  });

  it('does NOT flag file with "test" in a non-path segment', () => {
    // "contest" has "test" in the name but not as a directory
    expect(isTestFilePath('lib/utils/latest.ts')).toBe(false);
  });

  it('does NOT flag file whose directory ends with __tests but is not root-anchored', () => {
    // Starts with something else — would only be caught by suffix check
    expect(isTestFilePath('lib/__tests__-backup/old.ts')).toBe(false);
  });
});

/**
 * Single-source guarantee: isTestFilePath must be importable from resolve.ts.
 * If it has been removed from there (e.g. accidentally moved to a local copy),
 * this import will fail at module load time.
 */
describe('isTestFilePath — single-source contract', () => {
  it('is exported from resolve.ts (not a local re-implementation)', () => {
    // The import at the top of the file proves this. Calling it here confirms
    // the function is callable and returns a boolean.
    expect(typeof isTestFilePath).toBe('function');
    expect(typeof isTestFilePath('any/path.ts')).toBe('boolean');
  });
});
