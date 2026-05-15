import type { Foo } from './target.js';

export function processFoo(input: Foo): string {
  return input.value;
}
