import type { TargetType } from './target';

// TargetType used as a generic parameter — kind: 'generic'.
// Accessing .prop on elements — kind: 'propertyAccess'.
export function processAll(items: Array<TargetType>): string[] {
  return items.map((item) => item.prop);
}
