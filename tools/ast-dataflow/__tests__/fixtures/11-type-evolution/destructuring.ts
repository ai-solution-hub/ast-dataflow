import type { TargetType } from './target';

// Destructuring pattern on a TargetType value — kind: 'destructuring'.
export function destructureProp(x: TargetType): string {
  const { prop } = x;
  return prop;
}
