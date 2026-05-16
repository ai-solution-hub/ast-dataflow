import type { TargetType } from './target';

// The `satisfies` clause constrains the object to TargetType — kind: 'satisfies'.
export const myObj = {
  prop: 'value',
  other: 1,
} satisfies TargetType;
