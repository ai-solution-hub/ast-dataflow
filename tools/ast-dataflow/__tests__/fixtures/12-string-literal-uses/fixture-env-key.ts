/**
 * Fixture: process.env bracket-access key site.
 *
 * string-literal-uses --value 'MY_API_KEY' must return this file
 * with kind 'envKey' for the process.env['MY_API_KEY'] bracket access.
 *
 * The second access process.env['OTHER_KEY'] must NOT appear in results.
 *
 * A bare string literal 'MY_API_KEY' used as a regular argument must
 * appear as kind 'argument', not 'envKey' — different node ancestor.
 */

declare const process: { env: Record<string, string | undefined> };

// envKey site
const apiKey = process.env['MY_API_KEY'];

// Different key — must NOT appear in results for 'MY_API_KEY'
const otherKey = process.env['OTHER_KEY'];

// Argument use — same value but not in env context; kind must be 'argument'
declare function applyKey(k: string): void;
applyKey('MY_API_KEY');

export { apiKey, otherKey };
