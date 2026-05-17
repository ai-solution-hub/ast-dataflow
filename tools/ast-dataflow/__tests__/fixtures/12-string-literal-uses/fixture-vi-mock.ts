/**
 * Fixture: vi-mock call site.
 *
 * string-literal-uses --value '@/lib/foo' must return this file
 * with kind 'viMock' for the vi.mock(...) argument literal.
 *
 * The second string '@/lib/other' must NOT appear in results for '@/lib/foo'.
 */

// Simulated vi.mock call (in fixture scope, vi is referenced as an object).
// In real Vitest tests, vi is imported from 'vitest'. Here we declare it
// to keep the fixture self-contained without external imports.
declare const vi: { mock: (path: string) => void };

vi.mock('@/lib/foo');
vi.mock('@/lib/other');

export {};
