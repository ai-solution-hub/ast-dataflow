// Test-directory consumer — rows from this file must disappear under
// --exclude-tests (type-evolution previously ignored the flag entirely).
import type { TargetShape } from '../types-shape.js';

export function shapeFromTest(shape: TargetShape): string {
  return shape.project_id;
}
