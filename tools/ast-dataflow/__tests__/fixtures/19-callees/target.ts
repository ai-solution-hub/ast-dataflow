import { util } from './lib';
import { util2 as u2 } from './lib2';
import { Widget } from './widget';

function helper(): number {
  return 1;
}

function helper2(x: number): number {
  return x * 2;
}

const handlers: Record<string, () => void> = {};

export function subject(cb: () => void, name: string, arr: number[]): number {
  helper();
  util();
  u2();
  const fnRef = helper;
  fnRef();
  cb();
  handlers[name]();
  arr.map((x) => helper2(x));
  const w = new Widget(3);
  return w.size;
}
