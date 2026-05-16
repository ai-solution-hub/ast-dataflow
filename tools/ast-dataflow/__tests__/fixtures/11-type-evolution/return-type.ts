import type { TargetType } from './target';

// The function's return type is TargetType — kind: 'returnType'.
// Downstream accesses on the returned value — kind: 'propertyAccess'.
export function makeTarget(): TargetType {
  return { prop: 'hello', other: 42 };
}

// A caller that accesses .prop on the return value
export function readReturn(): string {
  const result = makeTarget();
  return result.prop;
}
