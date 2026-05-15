import { target } from './target';

// Case: module-level export async function declaration — existing handler (already covered).
// FunctionDeclaration with a name.
// expected: fn:POST
export async function POST() {
  return target();
}
