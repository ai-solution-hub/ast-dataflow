export interface TargetShape {
  project_id: string;
  label: string;
}

// Production consumer — must survive --exclude-tests.
export function readShape(shape: TargetShape): string {
  return shape.project_id;
}
