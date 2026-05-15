import { target } from './target';

// Case: nested anonymous callbacks — target() is inside a .map() inside a .then(),
// both inside named outer function 'fetchAndProcess'.
// Walking past both anonymous callbacks bubbles up to the named outer.
// expected: fn:fetchAndProcess
export function fetchAndProcess(items: string[]): Promise<string[]> {
  return Promise.resolve(items)
    .then((list) =>
      list.map((_item) => target()),
    );
}
