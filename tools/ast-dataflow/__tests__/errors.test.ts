/**
 * errors.test.ts
 *
 * Covers PRODUCT.md invariant 29: "Errors are returned as structured failures,
 * not crashes." Verifies all four ErrorKind cases:
 *
 *   unknown_file    — file path not found in the ts-morph project
 *   parse_error     — malformed symbol format or empty required arg
 *   ambiguous_symbol — symbol resolves to multiple declarations
 *   out_of_corpus   — symbol name not found in a file that IS in the project
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callers,
  importers,
  references,
  createProject,
} from '@/lib/ast-dataflow';

const CALLERS_FIXTURE_DIR = resolve(__dirname, 'fixtures', '01-callers');

const IMPORTERS_FIXTURE_DIR = resolve(__dirname, 'fixtures', '05-importers');

// ── unknown_file ─────────────────────────────────────────────────────────────

describe('ErrorKind: unknown_file', () => {
  it('callers returns error.kind = unknown_file for a file path not in the project', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'definitely/not/a/real/file.ts:someSymbol' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('unknown_file');
    expect(response.results).toEqual([]);
  });

  it('callers includes an informative message for unknown_file', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'nonexistent/path/file.ts:foo' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('unknown_file');
    expect(response.error?.message).toMatch(/File not in project/);
  });
});

// ── parse_error ───────────────────────────────────────────────────────────────

describe('ErrorKind: parse_error', () => {
  it('callers returns error.kind = parse_error when symbol has no colon separator', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'no-colon-here' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });

  it('callers returns parse_error when symbol has empty file or name parts', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers({ symbol: ':' }, project, repoRoot);

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
  });

  it('importers returns error.kind = parse_error for empty modulePath', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(IMPORTERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: IMPORTERS_FIXTURE_DIR,
    });

    const response = await importers({ modulePath: '' }, project, repoRoot);

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });

  it('parse_error response carries an informative message', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'malformed-no-colon' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('parse_error');
    expect(response.error?.message).toMatch(/Symbol must be/);
  });
});

// ── out_of_corpus ─────────────────────────────────────────────────────────────

describe('ErrorKind: out_of_corpus', () => {
  it('callers returns error.kind = out_of_corpus when symbol name is not found in a known file', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:doesNotExistAnywhere' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('out_of_corpus');
    expect(response.results).toEqual([]);
  });

  it('out_of_corpus response has a non-empty message', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:ghostSymbol' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('out_of_corpus');
    expect(response.error?.message).toMatch(/not found in/);
    expect(response.error?.hint).toBeDefined();
  });
});

// ── ambiguous_symbol ──────────────────────────────────────────────────────────

describe('ErrorKind: ambiguous_symbol', () => {
  /**
   * Fires when resolveSymbol finds more than one non-function candidate after
   * de-duplication. The resolver prefers FunctionDeclaration / MethodDeclaration
   * when one exists (the function+re-export-shim pattern), so a true ambiguity
   * needs two declarations of the same name where neither is a function.
   *
   * Fixture: two `export const` declarations with the same name. TypeScript
   * rejects this at compile time, but ts-morph still parses both into the
   * AST and `getVariableDeclarations()` returns both — exactly the shape
   * resolveSymbol must guard against.
   */
  it('callers returns error.kind = ambiguous_symbol when two non-function declarations share a name', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    project.createSourceFile(
      resolve(CALLERS_FIXTURE_DIR, 'dual-const.ts'),
      `
export const dualConst = 1;
export const dualConst = () => 2;
`,
      { overwrite: true },
    );

    const response = await callers(
      { symbol: 'dual-const.ts:dualConst' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('ambiguous_symbol');
    expect(response.results).toEqual([]);
    expect(response.error?.message).toMatch(/Ambiguous symbol/);
  });
});

// ── references query: structured errors via the same envelope ────────────────

describe('references query — structured error envelope', () => {
  it('returns error.kind = unknown_file for a file path not in the project', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await references(
      { symbol: 'definitely/not/a/real/file.ts:someSymbol' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('unknown_file');
    expect(response.results).toEqual([]);
  });

  it('returns error.kind = parse_error for a malformed symbol', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await references(
      { symbol: 'no-colon-here' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });
});

// ── Cross-cutting: structured error shape ─────────────────────────────────────

describe('Error envelope shape', () => {
  it('error response has results: [] and durationMs >= 0', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'no-colon-at-all' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.results).toEqual([]);
    expect(response.truncated).toBe(false);
    expect(response.durationMs).toEqual(expect.any(Number));
  });

  it('successful response has no error field', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(CALLERS_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: CALLERS_FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    expect(response.results.length).toBeGreaterThan(0);
  });
});
