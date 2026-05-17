/**
 * Fixture: plain function-argument literal site.
 *
 * string-literal-uses --value 'project_id' must return this file
 * with kind 'argument' for the generic function call argument.
 *
 * The second argument 'other_column' must NOT appear in results.
 */

declare function query(column: string): void;
declare function filter(key: string, value: string): void;

// 'argument' site — first argument to a generic call
query('project_id');

// Second argument — same function, different value; must NOT match
query('other_column');

// 'argument' in a two-arg call
filter('project_id', 'value');

export {};
