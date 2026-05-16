import type { TargetType } from './target';

// Bare property access on a typed variable — kind: 'propertyAccess'.
export function readProp(obj: TargetType): string {
  return obj.prop;
}
