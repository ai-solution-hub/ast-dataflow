/**
 * Fixture: second file with plain function-argument literal sites.
 *
 * Exists so the truncation integration test has 'project_id' hits spread
 * across TWO files (this one + fixture-argument.ts, two sites each). With a
 * low --limit, spatial-coverage truncation must keep both files represented
 * rather than exhausting the cap on whichever file is discovered first.
 *
 * string-literal-uses --value 'project_id' must return this file
 * with kind 'argument' for both call sites below.
 */

declare function lookup(column: string): void;
declare function update(key: string, value: string): void;

// 'argument' site — first argument to a generic call
lookup('project_id');

// 'argument' in a two-arg call
update('project_id', 'value');

export {};
