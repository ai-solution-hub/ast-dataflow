import { target } from './target';

// Case: module-level export const with arrow function — Next.js route handler pattern.
// ArrowFunction → VariableDeclaration → VariableDeclarationList → VariableStatement → SourceFile
// expected: fn:GET
export const GET = async () => {
  return target();
};
