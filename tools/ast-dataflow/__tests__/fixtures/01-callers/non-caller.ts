import { alsoCalled } from './target';

// References `target` by name in a comment, not as a callable — must NOT be a hit.
export function noOp(): number {
  return alsoCalled();
}
