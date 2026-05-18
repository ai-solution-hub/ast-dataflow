/**
 * Fixture: test file with unmissed string-literal sites.
 *
 * Simulates a Vitest test file that was NOT fully updated by gitnexus_rename.
 * The TypeScript import was updated (gitnexus graph edit, high confidence)
 * but two string literals referencing the OLD name remain:
 *
 *   1. vi.mock('@/lib/reports/generate-report') — gitnexus classified this as
 *      ast_search ("review carefully") and the executor missed it.
 *
 *   2. A call argument using the OLD function name as a string key —
 *      'generateReport' passed to a mock registry lookup.
 *
 * The rename-sweep verifier Q1 (string-literal-uses) MUST find both sites.
 * This is the "unmissed site" the fixture is designed to expose.
 */

// Import was correctly updated by gitnexus (high-confidence graph edge)
import { generateChangeReport } from './post-rename-source';

// Simulate vi fixture object — declared to keep this file self-contained
declare const vi: {
  mock: (path: string) => void;
  spyOn: (obj: object, method: string) => unknown;
};

// UNMISSED SITE 1: vi.mock string literal still references old module path
vi.mock('@/lib/reports/generate-report');

// UNMISSED SITE 2: string argument still uses old function name as a key
declare function registerMock(name: string, impl: unknown): void;
registerMock('generateReport', () => ({
  id: 'mock-id',
  title: 'mock',
  generatedAt: new Date(),
}));

// Correct usage of the renamed symbol (TypeScript-resolved, not a string)
const report = generateChangeReport('test title');
void report;
