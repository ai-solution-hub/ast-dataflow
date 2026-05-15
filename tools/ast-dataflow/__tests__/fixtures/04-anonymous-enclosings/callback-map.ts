import { target } from './target';

// Case: CallExpression callback — arrow function passed to .map().
// The outer named function 'processItems' contains the .map() call.
// Expected: fn:processItems
export function processItems(items: string[]): string[] {
  return items.map((_item) => target());
}
