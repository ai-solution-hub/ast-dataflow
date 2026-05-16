import type { TargetType } from './target';

// The parameter `x` is annotated as TargetType — kind: 'annotation'.
// Accessing x.prop inside the function body — kind: 'propertyAccess'.
export function useAnnotated(x: TargetType): string {
  return x.prop;
}
