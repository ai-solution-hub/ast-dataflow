// eslint-disable-next-line @typescript-eslint/no-unused-vars -- fixture intent: prove `importers` detects unused named imports
import { bar } from './target.js';

export function doSomethingElse(): string {
  return 'nothing to do with bar';
}
